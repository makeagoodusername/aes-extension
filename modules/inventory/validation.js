class Validation {
    valid = true
    errors = []

    constructor() {
        this.checkAllFlightNumbersSelected()
        this.checkApplyToSettings()
        this.checkServiceClasses()
        this.checkFlightStatus()
        this.checkLoad()
        this.checkGroupByFlight()
    }

    /**
     * Check that the "All Flight Numbers" tab is active. Anchored on the
     * tab link's text rather than positional :eq(0) so an AS template
     * change that adds a tab on the left can't shift the active check.
     * The fixture uses "All Flights Numbers" (sic); regex tolerates both.
     */
    checkAllFlightNumbersSelected() {
        const message = "Please select \"All Flight Numbers\" under Current Inventory"
        const tab = $('ul.nav-tabs > li').filter(function () {
            return /all\s*flights?\s*numbers/i.test($(this).text())
        }).first()
        const active = tab.length > 0 && tab.hasClass("active")
        if (!active) {
            this.valid = false
            this.errors.push(message)
        }
    }

    /**
     * Check "Apply settings to" checkboxes. AS gives each checkbox a stable
     * `name` attribute (`settings:airportPair`, `settings:flightNumbers`,
     * `settings:returnAirportPair`, `settings:returnFlightNumbers`) — far
     * more durable than the prior `:eq(N)` index walk.
     */
    checkApplyToSettings() {
        const checks = [
            {name: "settings:airportPair",         want: true,  msg: "Please check “Airport Pair” under “Apply settings to” in the “Settings”-panel"},
            {name: "settings:flightNumbers",       want: true,  msg: "Please check “Flight Numbers” under “Apply settings to” in the “Settings”-panel"},
            {name: "settings:returnAirportPair",   want: false, msg: "Please uncheck “Return Airport Pair” under “Apply settings to” in the “Settings”-panel"},
            {name: "settings:returnFlightNumbers", want: false, msg: "Please uncheck “Return Flight Numbers” under “Apply settings to” in the “Settings”-panel"}
        ]
        let valid
        const messages = []
        for (const c of checks) {
            const input = $(`input[name="${c.name}"]`)[0]
            if (!input) continue
            if (input.checked !== c.want) {
                valid = false
                messages.push(c.msg)
            }
        }
        if (valid === false) {
            this.valid = valid
            this.errors.push(...messages)
        }
    }

    /**
     * Check that all "Service Classes" are selected. Anchored on the
     * fieldset's `<legend>` text plus the inputs' stable
     * `name="serviceClasses"`.
     */
    checkServiceClasses() {
        let valid
        const messages = []
        const labels = Validation._fieldsetByLegend("Service Classes").find('label')
        labels.each(function () {
            const input = $('input[name="serviceClasses"]', this)[0]
            if (!input || !input.checked) {
                valid = false
                messages.push(`Please check “${$(this).text().trim()}” under “Service Classes” in the “Data”-panel`)
            }
        })
        if (valid === false) {
            this.valid = valid
            this.errors.push(...messages)
        }
    }

    /**
     * Check "Flight Status" — `inflight` (value 1) and `finished` (value 2)
     * must be checked. Anchored on the input's value attribute so a
     * future AS reorder of the row order doesn't break the rule.
     */
    checkFlightStatus() {
        let valid
        const messages = []
        const required = ["1", "2"]
        const inputs = Validation._fieldsetByLegend("Flight Status").find('input[name="flightStati"]')
        inputs.each(function () {
            if (required.indexOf(String(this.value)) === -1) return
            if (!this.checked) {
                const labelText = $(this).closest('label').text().trim()
                valid = false
                messages.push(`Please check “${labelText}” under “Flight Status” in the “Data”-panel`)
            }
        })
        if (valid === false) {
            this.valid = valid
            this.errors.push(...messages)
        }
    }

    /**
     * Check "Load" — Minimum must be 0, Maximum must be 100. Selects have
     * stable name attributes (`loadMin`, `loadMax`).
     */
    checkLoad() {
        let valid
        const messages = []
        const fieldset = Validation._fieldsetByLegend("Load")
        const checks = [
            {sel: 'select[name="loadMin"]', want: 0,   word: "0"},
            {sel: 'select[name="loadMax"]', want: 100, word: "100"}
        ]
        for (const c of checks) {
            const select = fieldset.find(c.sel)[0]
            if (!select) continue
            const value = parseInt($('option:selected', select).text(), 10)
            if (value !== c.want) {
                const wrap = $(select).closest('.form-group, div')
                const label = wrap.find('label').first().text().trim()
                valid = false
                messages.push(`Please select ${c.word} for “${label}” under “Load” in the “Data”-panel`)
            }
        }
        if (valid === false) {
            this.valid = valid
            this.errors.push(...messages)
        }
    }

    /**
     * Check "Group by flight" — the `display` checkbox (inside the fieldset
     * AS labels "Settings") must be unchecked. Anchored on the input's
     * stable `name="display"` attribute.
     */
    checkGroupByFlight() {
        let valid
        const messages = []
        const checkbox = $('input[name="display"]')[0]
        if (checkbox && checkbox.checked) {
            const labelText = $(checkbox).closest('label').text().trim()
                || $(`label[for="${checkbox.id}"]`).text().trim()
                || "Group by flight"
            valid = false
            messages.push(`Please uncheck “${labelText}” under “Settings” in the “Data”-panel`)
        }
        if (valid === false) {
            this.valid = valid
            this.errors.push(...messages)
        }
    }

    /**
     * Walk every fieldset on the page and return the one whose `<legend>`
     * text matches `text` (case-insensitive, whitespace-trimmed). Returns
     * an empty jQuery set if no match — callers' subsequent `.find()` calls
     * stay null-safe.
     */
    static _fieldsetByLegend(text) {
        const want = String(text).trim().toLowerCase()
        return $('fieldset').filter(function () {
            const legend = $(this).children('legend').first().text().trim().toLowerCase()
            return legend === want
        })
    }
}
