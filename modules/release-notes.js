"use strict"

/**
 * Per-version release-notes dialog. Auto-opens once after an update (keyed
 * by `aesReleaseNotesSeenVersion` in chrome.storage.local), and can be
 * reopened from the AS footer link the module installs ("AES: v…"). Adapted
 * from upstream AES v0.7.8 `modules/release-notes.js`.
 *
 * Public API on `window.AesReleaseNotes`:
 *   - `RELEASE_NOTES`             — dict keyed by manifest version
 *   - `STORAGE_KEY`               — chrome.storage.local key for last-seen version
 *   - `show(version?)`            — force-open the dialog (optional version override)
 *   - `addFooterLink()`           — idempotent footer link installer
 *   - `maybeShow()`               — open-once gate, called automatically on load
 *
 * Storage key contract: `aesReleaseNotesSeenVersion` (single string value).
 * New top-level key — needs an entry in HANDOVER.md §4 storage-key registry.
 */
;(function () {
    if (window.AesReleaseNotes) return

    const STORAGE_KEY = "aesReleaseNotesSeenVersion"

    // Seed entry for the current target version. Replace `sections` with
    // real release-notes copy before shipping. Adding new entries keyed by
    // future version_name strings is the supported way to extend this.
    const RELEASE_NOTES = {
        "0.6.13-beta": {
            title: "Release Notes",
            releaseDate: "2026-05-04",
            summary: "This release backports a stack of proven fixes and features from the upstream AirlineSim Enhancement Suite v0.7.0 through v0.7.8 line, while keeping every fork-specific subsystem (route-assistant, strategy, conductor, central-hub) intact.",
            sections: [
                {
                    title: "Added",
                    items: [
                        "Inventory \"Group by flight\" layouts are now supported. AES re-renders automatically when you toggle the AS layout, no full page refresh required.",
                        "Optional reference recommendations on Inventory Pricing - turn on \"Show reference recommendation\" in Settings to see what AES would suggest when the current price has no flight results yet.",
                        "Aircraft Flights page now auto-detects the home base (HUB) from each tail's flight history, with an override input + save/reset controls when you want to force a different hub. The override syncs back into Fleet Management and Aircraft Profitability.",
                        "Fleet Management table extracts richer per-tail data: delivery status, ownership, pilot assignment, seat configuration, schedule state. New Model header and HUB column.",
                        "Fleet Management page now has an AES filter panel above the table - filter by Model, HUB, seat config, delivery state, ownership, or schedule. The native AS \"select all/none/inverse\" links honor the filter so you operate only on visible aircraft.",
                        "Aircraft Profitability tile now shows the new columns (HUB, schedule state Active/Locked/Conflict/Empty, pilot, ownership, seat config) sourced from the richer fleet extraction.",
                        "Aircraft Profitability table now shows a summary row at the bottom with averaged age and summed flight / profit totals across the visible fleet.",
                        "Per-controlled-airline competitor monitoring - each airline you control now keeps its own competitor list instead of sharing one server-wide list. Existing tracked competitors keep loading via dual-read fallback."
                    ]
                },
                {
                    title: "Changed",
                    items: [
                        "Vendored jQuery upgraded from 3.4.1 to 3.7.1 (slim build) - same proven version the upstream extension ships.",
                        "Inventory analysis table merges \"New Price\" into the recommendation arrow and right-aligns the load column for cleaner reading.",
                        "Personnel Management applies salary changes in one pass instead of requiring a refresh per row.",
                        "Competitor Monitoring scrape uses label-based row lookup, so it no longer breaks when AS reorders facts/figures rows.",
                        "Competitor Monitoring filter chrome is rendered even before any competitors are tracked, so the filter UI stays discoverable."
                    ]
                },
                {
                    title: "Fixed",
                    items: [
                        "Inventory Pricing settings toggles (auto price update, auto tab close, history table options) are no longer overwritten by stale settings snapshots from another AS tab. Saves now use a read-modify-write primitive.",
                        "Fleet Management aircraft-id capture now tolerates relative paths (../aircraft/123) and other AS link variants - undelivered tails are kept in storage by registration when no aircraftId is yet assigned.",
                        "Empty profit / extract-date cells in Fleet Management render as centered \"--\" placeholders instead of empty cells, so columns don't visually collapse.",
                        "Aircraft Flights toast banners now render with the correct success/warning/error styling (the option key was being mis-routed).",
                        "Fleet Management filter overlay re-applies after AS rerenders the fleet table (sort, pagination, refresh) so AES extras don't disappear.",
                        "Aircraft Profitability \"remove aircraft (permanent)\" can now remove undelivered tails too (matched by registration), and the fleet-storage key is sanitized so airlines whose names contain whitespace or punctuation can finally be removed."
                    ]
                }
            ]
        },
        "0.6.12-beta": {
            title: "Release Notes",
            releaseDate: "2026-05-04",
            summary: "Thanks for keeping AES up to date.",
            sections: [
                {
                    title: "Added",
                    items: [
                        "Release notes now open automatically after an update and can be reopened from the AS footer link (\"AES: v…\").",
                        "Notification helper class is available for modules that want a lightweight feedbackPanel-style toast."
                    ]
                },
                {
                    title: "Changed",
                    items: [
                        "Content-script filenames flightSchedule, enterpriseOverview, and personnelManagement are now spelled correctly. Internal storage keys are unchanged so saved data continues to load."
                    ]
                },
                {
                    title: "Fixed",
                    items: [
                        "Site-skin keyboard shortcut registration always installs showShortcuts; only the chord listener is gated by skin state.",
                        "Aircraft Flights placeholder row no longer throws on empty fleets, and mounting is idempotent with airline-scoped storage keys."
                    ]
                }
            ]
        }
    }

    class ReleaseNotesDialog {
        #container
        #backdrop
        #closeButton
        #confirmButton
        #version

        constructor(version, notes) {
            this.#version = version
            this.#closeButton = this.#createCloseButton()
            this.#confirmButton = this.#createConfirmButton()
            this.#container = this.#createContainer(version, notes)
            this.#backdrop = this.#createBackdrop()
            document.body.append(this.#backdrop, this.#container)
            document.body.classList.add("modal-open")
            this.#bindEvents()
        }

        #createContainer(version, notes) {
            const container = document.createElement("div")
            container.id = "aes-release-notes-dialog"
            container.className = "modal fade in"
            container.setAttribute("role", "dialog")
            container.setAttribute("aria-modal", "true")
            container.style.display = "block"
            container.classList.add("aes-release-notes-theme-" + this.#getTheme())

            const dialog = document.createElement("div")
            dialog.className = "modal-dialog modal-lg"

            const content = document.createElement("div")
            content.className = "modal-content"

            const header = document.createElement("div")
            header.className = "modal-header aes-release-notes-header"
            const hero = document.createElement("div")
            hero.className = "aes-release-notes-hero"
            const heroBrand = document.createElement("div")
            heroBrand.className = "aes-release-notes-brand"
            const logo = document.createElement("img")
            logo.className = "aes-release-notes-logo"
            logo.src = chrome.runtime.getURL("images/AES-logo-128.png")
            logo.alt = "AES logo"
            const titleWrap = document.createElement("div")
            titleWrap.className = "aes-release-notes-title-wrap"
            const title = document.createElement("h3")
            title.className = "modal-title"
            title.textContent = notes.title
            const versionLabel = document.createElement("p")
            versionLabel.className = "aes-release-notes-version"
            versionLabel.textContent = this.#formatVersionLabel(version, notes.releaseDate)
            const badge = document.createElement("span")
            badge.className = "aes-release-notes-badge"
            badge.textContent = "What's new"

            titleWrap.append(badge, title, versionLabel)
            if (notes.summary) {
                const summary = document.createElement("p")
                summary.className = "aes-release-notes-summary"
                summary.textContent = notes.summary
                titleWrap.append(summary)
            }
            heroBrand.append(logo, titleWrap)
            hero.append(this.#closeButton, heroBrand)
            header.append(hero)

            const body = document.createElement("div")
            body.className = "modal-body aes-release-notes-body"
            const sections = document.createElement("div")
            sections.className = "aes-release-notes-sections"

            ;(notes.sections || []).forEach(function (section) {
                const card = document.createElement("section")
                card.className = "aes-release-notes-card"
                const sectionTitle = document.createElement("h4")
                sectionTitle.className = "aes-release-notes-card-title"
                sectionTitle.textContent = section.title

                const list = document.createElement("ul")
                list.className = "aes-release-notes-list"
                ;(section.items || []).forEach(function (item) {
                    const li = document.createElement("li")
                    li.textContent = item
                    list.append(li)
                })

                card.append(sectionTitle, list)
                sections.append(card)
            })
            body.append(sections)

            const footer = document.createElement("div")
            footer.className = "modal-footer aes-release-notes-footer"

            const changelogLink = document.createElement("a")
            changelogLink.className = "btn btn-default aes-release-notes-link"
            changelogLink.href = "https://github.com/NEWLY2014/AirlineSim-Enhancement-Suite/blob/main/CHANGELOG.md"
            changelogLink.target = "_blank"
            changelogLink.rel = "noopener noreferrer"
            changelogLink.textContent = "View full changelog"

            footer.append(changelogLink, this.#confirmButton)
            content.append(header, body, footer)
            dialog.append(content)
            container.append(dialog)

            return container
        }

        #createBackdrop() {
            const b = document.createElement("div")
            b.className = "modal-backdrop fade in aes-release-notes-backdrop"
            return b
        }

        #createCloseButton() {
            const button = document.createElement("button")
            button.setAttribute("type", "button")
            button.className = "close aes-release-notes-close"
            button.setAttribute("aria-label", "Close")
            button.innerHTML = "&times;"
            return button
        }

        #createConfirmButton() {
            const button = document.createElement("button")
            button.type = "button"
            button.className = "btn btn-primary aes-release-notes-confirm"
            button.textContent = "Got it"
            return button
        }

        #bindEvents() {
            const dismiss = this.dismiss.bind(this)
            this.#closeButton.addEventListener("click", dismiss)
            this.#confirmButton.addEventListener("click", dismiss)
            this.#backdrop.addEventListener("click", dismiss)
            document.addEventListener("keydown", this.#onKeydown)
        }

        #onKeydown = (event) => {
            if (event.key === "Escape") this.dismiss()
        }

        dismiss() {
            chrome.storage.local.set({ [STORAGE_KEY]: this.#version }, () => {
                document.removeEventListener("keydown", this.#onKeydown)
                this.#container.remove()
                this.#backdrop.remove()
                document.body.classList.remove("modal-open")
            })
        }

        #formatVersionLabel(version, releaseDate) {
            if (!releaseDate) return "Version " + version
            return "Version " + version + " - Released " + releaseDate
        }

        #getTheme() {
            const t = window.frontendSettings && window.frontendSettings.theme
            if (t === "classic" || t === "light") return t
            return "dark"
        }
    }

    function currentVersion() {
        const m = chrome.runtime.getManifest()
        return m.version_name || m.version
    }

    function show(versionOverride) {
        const version = versionOverride || currentVersion()
        const notes = RELEASE_NOTES[version]
        if (!notes) return
        if (document.getElementById("aes-release-notes-dialog")) return
        new ReleaseNotesDialog(version, notes)
    }

    function maybeShow() {
        if (window.top !== window.self) return
        const version = currentVersion()
        if (!RELEASE_NOTES[version]) return
        chrome.storage.local.get([STORAGE_KEY], function (result) {
            if (result[STORAGE_KEY] === version) return
            show(version)
        })
    }

    function addFooterLink() {
        const version = currentVersion()
        if (!RELEASE_NOTES[version]) return
        const footerLine = document.querySelector(".as-footer-line")
        if (!footerLine || document.getElementById("aes-footer-version")) return

        const wrapper = document.createElement("div")
        wrapper.id = "aes-footer-version"
        wrapper.className = "as-footer-line-element version"

        const link = document.createElement("a")
        link.href = "#"
        link.className = "aes-footer-version-link"
        link.textContent = "AES: v" + version
        link.addEventListener("click", function (event) {
            event.preventDefault()
            show(version)
        })

        wrapper.append(link)

        const gameVersion = footerLine.querySelector("#version")
        if (gameVersion) {
            footerLine.insertBefore(wrapper, gameVersion)
        } else {
            footerLine.append(wrapper)
        }
    }

    window.AesReleaseNotes = {
        STORAGE_KEY,
        RELEASE_NOTES,
        ReleaseNotesDialog,
        show,
        maybeShow,
        addFooterLink
    }

    addFooterLink()
    maybeShow()
})()
