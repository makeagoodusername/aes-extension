"use strict"

/**
 * Content script for AirlineSim flight-number pages.
 *
 * Existing Track 6 slice 6c behavior is preserved for
 * /app/com/numbers/<flightId>: the AFP delete-batch pipeline submits the
 * detail page's delete form after asserting the URL is exactly the
 * expected flight id.
 *
 * This file also owns the list-page grouping surface at /app/com/numbers:
 * it reads the visible AS DOM as the source of truth, can create a group,
 * and can sort visible flight-number rows into a selected group. The
 * mutating calls are deliberately form-driven instead of URL-synthesized
 * because Wicket action ids drift across page loads.
 */
;(function () {
    const LIST_PATH = "/app/com/numbers"
    const MAX_GROUP_NAME_LEN = 45

    function _text(el) {
        return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim()
    }

    function _norm(s) {
        return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase()
    }

    function _cleanGroupName(raw) {
        const s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim()
        return s.slice(0, MAX_GROUP_NAME_LEN)
    }

    function _isListPage() {
        return location.pathname === LIST_PATH || location.pathname === LIST_PATH + "/"
    }

    function _findHeading(re) {
        const nodes = document.querySelectorAll("h1,h2,h3,h4")
        for (const h of nodes) {
            if (re.test(_text(h))) return h
        }
        return null
    }

    function _numbersIdFromHref(href) {
        const s = String(href || "")
        const m = /(?:^|\/|\.\/)numbers\/(\d+)(?:[/?#]|$)/i.exec(s)
        return m ? m[1] : null
    }

    function _numbersLink(row) {
        if (!row || !row.querySelector) return null
        const links = row.querySelectorAll("a[href]")
        for (const a of links) {
            const raw = a.getAttribute("href") || ""
            if (_numbersIdFromHref(raw) || _numbersIdFromHref(a.href || "")) return a
        }
        return null
    }

    function _iataFromCell(cell) {
        const link = cell && cell.querySelector && cell.querySelector('a[href*="/app/info/airports/"], a[href*="/info/airports/"]')
        const txt = link ? _text(link) : _text(cell)
        const m = /\(([A-Z0-9]{3})\)\s*$/.exec(txt) || /\b([A-Z0-9]{3})\b/.exec(txt)
        return m ? m[1] : null
    }

    function _selectOptionSnapshot(select) {
        if (!select) return []
        return Array.from(select.options || []).map((opt, idx) => ({
            index:    idx,
            value:    opt.value,
            label:    _text(opt),
            selected: !!opt.selected,
            unsorted: opt.value === "" || /unsorted flight numbers/i.test(_text(opt))
        }))
    }

    function _findCreateGroupForm() {
        const form = document.querySelector('form[action*="flight.numbers.group.add"]')
        if (!form) return null
        const input = form.querySelector('input[type="text"][name$=":input"], input[type="text"][maxlength="45"], input[type="text"]')
        const submit = form.querySelector('button[type="submit"], input[type="submit"]')
        return {form, input, submit}
    }

    function _findGroupingForm() {
        const form = document.querySelector('form[action*="flight.numbers.form"]')
        if (!form) return null
        const select = form.querySelector('select[name="grouping.select"]')
        const submit = form.querySelector('input[type="submit"][name="grouping.button"], button[type="submit"][name="grouping.button"]')
        return {form, select, submit}
    }

    function _readGroups(grouping) {
        const selectOptions = _selectOptionSnapshot(grouping && grouping.select)
        const byLabel = new Map()
        for (const opt of selectOptions) byLabel.set(_norm(opt.label), opt)

        const out = []
        const heading = _findHeading(/^flight number groups$/i)
        if (heading) {
            let cur = heading.nextElementSibling
            let walked = 0
            while (cur && walked++ < 500 && !/^H[1-4]$/i.test(cur.tagName || "")) {
                for (const row of cur.querySelectorAll ? cur.querySelectorAll("tr") : []) {
                    const link = _numbersLink(row)
                        || row.querySelector('a[href*="/app/com/numbers"], a[href*="/com/numbers"]')
                    if (!link) continue
                    const label = _text(link)
                    if (!label) continue
                    const rowText = _text(row)
                    const countHit = /\((\d+)\)/.exec(rowText)
                    const opt = byLabel.get(_norm(label)) || null
                    out.push({
                        name:     label,
                        count:    countHit ? parseInt(countHit[1], 10) : null,
                        href:     link.href || link.getAttribute("href") || "",
                        value:    opt ? opt.value : null,
                        unsorted: /unsorted flight numbers/i.test(label) || (opt ? opt.unsorted : false)
                    })
                }
                cur = cur.nextElementSibling
            }
        }

        for (const opt of selectOptions) {
            if (out.some(g => _norm(g.name) === _norm(opt.label))) continue
            out.push({
                name:     opt.label,
                count:    null,
                href:     "",
                value:    opt.value,
                unsorted: opt.unsorted
            })
        }

        return out
    }

    function _readVisibleNumbers() {
        const rows = []
        const tbody = document.querySelector("tbody#flightNumbers")
        const candidates = tbody ? tbody.querySelectorAll("tr") : document.querySelectorAll('form[action*="flight.numbers.form"] tbody tr')
        for (const row of candidates) {
            const cb = row.querySelector('input[type="checkbox"][name="checkGroup"]')
            const numberCell = row.querySelector("td.number")
            if (!cb || !numberCell) continue
            const cells = row.cells ? Array.from(row.cells) : []
            const numberText = _text(numberCell)
            const link = _numbersLink(row)
            const flightId = link
                ? (_numbersIdFromHref(link.getAttribute("href") || "") || _numbersIdFromHref(link.href || ""))
                : null
            rows.push({
                flightId:      flightId,
                flightNumber:  numberText,
                checkboxValue: cb.value,
                checked:       !!cb.checked,
                days:          _text(row.querySelector("td.days")),
                originIata:    _iataFromCell(cells[3]),
                departure:     _text(row.querySelector("td.departure") || cells[4]),
                destinationIata: _iataFromCell(cells[5]),
                rowClass:      row.className || ""
            })
        }
        return rows
    }

    function snapshot() {
        const create = _findCreateGroupForm()
        const grouping = _findGroupingForm()
        const snap = {
            ok: true,
            path: location.pathname,
            href: location.href,
            title: document.title || "",
            isListPage: _isListPage(),
            groups: _readGroups(grouping),
            visibleNumbers: _readVisibleNumbers(),
            forms: {
                createGroup: !!(create && create.form && create.input),
                grouping:    !!(grouping && grouping.form && grouping.select && grouping.submit)
            }
        }
        Object.defineProperty(snap, "_grouping", {value: grouping, enumerable: false})
        return snap
    }

    function _resolveGroup(snap, req) {
        const allowUnsorted = !!(req && req.allowUnsorted)
        const groupValue = req && req.groupValue != null ? String(req.groupValue) : null
        const groupName = _cleanGroupName(req && (req.groupName || req.name))
        const group = (snap.groups || []).find(g =>
            (groupValue != null && String(g.value) === groupValue)
            || (groupName && _norm(g.name) === _norm(groupName))
        )
        if (!group) return {error: "target group not found"}
        if (group.unsorted && !allowUnsorted) return {error: "refusing to sort into Unsorted flight numbers"}
        if (group.value == null) return {error: "group exists in side list but not in grouping select"}
        return {value: group.value, name: group.name, group}
    }

    function _targetSets(req) {
        const ids = new Set((req.flightIds || req.flightNumberIds || [])
            .filter(v => v != null).map(v => String(v)))
        const nums = new Set((req.flightNumbers || req.numbers || [])
            .filter(v => v != null).map(v => String(v).trim()))
        const checks = new Set((req.checkboxValues || [])
            .filter(v => v != null).map(v => String(v)))
        return {ids, nums, checks}
    }

    function _matchedRows(req, prefetchedRows) {
        const rows = prefetchedRows || _readVisibleNumbers()
        const sets = _targetSets(req || {})
        const allVisible = !!(req && req.allVisible)
        const matched = rows.filter(r => allVisible
            || (r.flightId && sets.ids.has(String(r.flightId)))
            || (r.flightNumber && sets.nums.has(String(r.flightNumber)))
            || (r.checkboxValue && sets.checks.has(String(r.checkboxValue))))

        const foundIds = new Set(matched.map(r => String(r.flightId)).filter(Boolean))
        const foundNums = new Set(matched.map(r => String(r.flightNumber)).filter(Boolean))
        const foundChecks = new Set(matched.map(r => String(r.checkboxValue)).filter(Boolean))
        const missing = {
            flightIds:      Array.from(sets.ids).filter(v => !foundIds.has(v)),
            flightNumbers:  Array.from(sets.nums).filter(v => !foundNums.has(v)),
            checkboxValues: Array.from(sets.checks).filter(v => !foundChecks.has(v))
        }
        return {rows, matched, missing, allVisible}
    }

    function _hasMissing(missing) {
        return !!(missing && (
            (missing.flightIds && missing.flightIds.length)
            || (missing.flightNumbers && missing.flightNumbers.length)
            || (missing.checkboxValues && missing.checkboxValues.length)
        ))
    }

    function _dispatchInput(el) {
        if (!el) return
        try { el.dispatchEvent(new Event("input", {bubbles: true})) } catch (_) {}
        try { el.dispatchEvent(new Event("change", {bubbles: true})) } catch (_) {}
    }

    function _submitWithButton(form, button) {
        if (!form) return
        if (button && typeof form.requestSubmit === "function") {
            form.requestSubmit(button)
            return
        }
        if (!button && typeof form.requestSubmit === "function") {
            form.requestSubmit()
            return
        }
        if (button && typeof button.click === "function") {
            button.click()
            return
        }
        form.submit()
    }

    function createGroup(req) {
        if (!_isListPage()) return {ok: false, error: "not on flight number list page"}
        const name = _cleanGroupName(req && (req.groupName || req.name))
        if (!name) return {ok: false, error: "missing groupName"}
        const snap = snapshot()
        const existing = snap.groups.find(g => _norm(g.name) === _norm(name))
        if (existing) return {ok: true, exists: true, group: existing, snapshot: snap}

        const found = _findCreateGroupForm()
        if (!found || !found.form || !found.input) {
            return {ok: false, error: "create group form not found", snapshot: snap}
        }

        found.input.value = name
        _dispatchInput(found.input)
        setTimeout(() => _submitWithButton(found.form, found.submit), 0)
        return {ok: true, posting: true, groupName: name}
    }

    function sortVisibleIntoGroup(req) {
        if (!_isListPage()) return {ok: false, error: "not on flight number list page"}
        const snap = snapshot()
        const grouping = snap._grouping
        if (!grouping || !grouping.form || !grouping.select || !grouping.submit) {
            return {ok: false, error: "grouping form not found", snapshot: snap}
        }

        const group = _resolveGroup(snap, req || {})
        if (group.error) return {ok: false, error: group.error, snapshot: snap}

        const targets = _matchedRows(req || {}, snap.visibleNumbers)
        if (!targets.matched.length) {
            return {ok: false, error: "no visible flight numbers matched target", missing: targets.missing, snapshot: snap}
        }
        if (_hasMissing(targets.missing) && !(req && req.allowPartial)) {
            return {ok: false, error: "some requested flight numbers are not visible", missing: targets.missing, matched: targets.matched, snapshot: snap}
        }

        const wantedChecks = new Set(targets.matched.map(r => String(r.checkboxValue)))
        for (const cb of grouping.form.querySelectorAll('input[type="checkbox"][name="checkGroup"]')) {
            cb.checked = wantedChecks.has(String(cb.value))
            _dispatchInput(cb)
        }
        grouping.select.value = group.value
        _dispatchInput(grouping.select)
        setTimeout(() => _submitWithButton(grouping.form, grouping.submit), 0)
        return {ok: true, posting: true, group: group, matched: targets.matched, missing: targets.missing}
    }

    function deleteFlightForm(msg) {
        const expectedId = msg.flightId != null ? String(msg.flightId) : ""
        if (!expectedId) return {ok: false, error: "missing flightId"}

        const expectedPath = LIST_PATH + "/" + expectedId
        if (location.pathname !== expectedPath) {
            return {
                ok: false,
                error: "wrong page (expected " + expectedPath + ", got " + location.pathname + ")"
            }
        }

        const form = document.querySelector('form[action$="-delete~form"]')
        if (!form) return {ok: false, error: "delete form not found"}
        const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')

        setTimeout(() => {
            try { _submitWithButton(form, submit) }
            catch (e) {
                console.warn("[AES afp-6c] delete submit threw", e)
            }
        }, 0)
        return {ok: true, posting: true}
    }

    window.AesFlightNumberGroups = {
        snapshot,
        createGroup,
        sortVisibleIntoGroup
    }

    const HANDLERS = {
        "aes:flight-numbers:snapshot":                () => snapshot(),
        "aes:flight-numbers:create-group":            (msg) => createGroup(msg),
        "aes:flight-numbers:sort-visible-into-group": (msg) => sortVisibleIntoGroup(msg),
        "aes:afp:delete-flight-form":                 (msg) => deleteFlightForm(msg)
    }

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            const handler = msg && msg.type ? HANDLERS[msg.type] : null
            if (!handler) return false
            try { sendResponse(handler(msg)) }
            catch (_) { /* page may be unloading after a form submit */ }
            return false
        })
    }
})()
