/**
 * Release notes auto-show + footer link. Ported from
 * AirlineSim-Enhancement-Suite-main v0.7.8 (NEWLY2014 fork) and conformed
 * to the host project's IIFE / window.<Namespace> convention with cubist
 * design tokens applied inline (matches modules/about-dialog.js pattern).
 *
 * Behavior:
 *   - On every /app/* + /action/* page load, ensures `AES: vX.Y.Z-beta`
 *     link is present in the AS footer (.as-footer-line) — clicking
 *     re-opens the dialog at any time.
 *   - On first page load after a version bump, opens the dialog once.
 *     Persistence key: chrome.storage.local["aesReleaseNotesSeenVersion"].
 *
 * Storage contract: write the resolved version_name (or version) string
 * verbatim. Future versions match by exact equality.
 *
 * Public surface:
 *   window.AesReleaseNotes = {
 *     open(),                // open the dialog for the current version
 *     ensureFooterLink()     // re-attach the footer link if AS re-rendered
 *   }
 */
;(function () {
    "use strict"

    if (window.AesReleaseNotes) {
        return
    }

    const STORAGE_KEY = "aesReleaseNotesSeenVersion"

    const RELEASE_NOTES = {
        "0.6.13-beta": {
            title: "Release Notes",
            releaseDate: "2026-05-04",
            summary: "Selected v0.7.8 (NEWLY2014 fork) modules integrated into the host build.",
            sections: [
                {
                    title: "Added",
                    items: [
                        "Release notes dialog auto-opens after a version bump and can be reopened from the footer 'AES: v…' link.",
                        "ORS results page now shows a numeric rating next to each rating image and a 'Difference' column (max - row).",
                        "Content-side feedback toast helper available at window.AesFeedbackToast.show(message, { type, duration }).",
                        "Unified Settings → Data tab now has a Backup & Restore section: typed JSON backup, merge/replace restore, and old-data cleanup."
                    ]
                },
                {
                    title: "Changed",
                    items: [
                        "AES.helpers gained five v0.7.8 utilities: updateSettings, getCompetitorMonitoringKey, getCompetitorMonitoringIndexKey, sleep, openPagesWithDelay.",
                        "InvPricing default settings include showReferenceRecommendation:0 (off-by-default; no behavior change for existing installs)."
                    ]
                }
            ]
        },
        "0.7.8": {
            title: "Release Notes",
            releaseDate: "2026-04-18",
            summary: "Thanks for keeping AES up to date.",
            sections: [
                {
                    title: "Added",
                    items: [
                        "Release notes now open automatically after an update and can be reopened from the footer version link.",
                        "Grouped inventory tables are now supported, and reference recommendations can be enabled explicitly for routes whose current price has no flight results yet."
                    ]
                },
                {
                    title: "Changed",
                    items: [
                        "The release notes dialog now adapts to dark, classic, and light AirlineSim themes and shows the release date next to the AES version.",
                        "Inventory Pricing now separates executable recommendations from optional reference recommendations, and recommendation prices are shown inline."
                    ]
                },
                {
                    title: "Fixed",
                    items: [
                        "Inventory Pricing settings now persist reliably across pages instead of being overwritten by stale settings snapshots.",
                        "Inventory analysis now reloads automatically after toggling Group by flight, and grouped-mode fallback analysis no longer shows invalid zero prices."
                    ]
                }
            ]
        },
        "0.7.7": {
            title: "Release Notes",
            releaseDate: "2026-04-13",
            summary: "Thanks for keeping AES up to date.",
            sections: [
                {
                    title: "Changed",
                    items: [
                        "Dashboard loading, filtering, and schedule table behavior were refined so each tab restores more cleanly and large datasets feel steadier while data loads.",
                        "The Flights page HUB override controls now sit more naturally within the native aircraft Flights page."
                    ]
                },
                {
                    title: "Fixed",
                    items: [
                        "Dashboard tab initialization, filter normalization, and competitor schedule rendering issues that could leave tabs blank or throw runtime errors were fixed.",
                        "Dashboard sorting, zero-value rendering, and Aircraft Profitability row actions were corrected so formatted numbers sort correctly and undelivered aircraft can still be managed safely.",
                        "Fleet Management filtering and native selection link integration were fixed so all / none / invert works with AES filters and native table refreshes no longer break AES-added columns."
                    ]
                }
            ]
        }
    }

    function resolveVersion() {
        const manifest = chrome.runtime.getManifest()
        return manifest.version_name || manifest.version
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
            container.style.cssText = "display:block;z-index:1050;"

            const dialog = document.createElement("div")
            dialog.className = "modal-dialog modal-lg"

            const content = document.createElement("div")
            content.className = "modal-content"
            content.style.cssText = [
                "background:var(--aes-bone)",
                "color:var(--aes-oxide)",
                "border:var(--aes-bw-2) solid var(--aes-oxide)",
                "border-radius:var(--aes-radius)",
                "box-shadow:none",
                "font-family:var(--aes-font-display)"
            ].join(";")

            const header = document.createElement("div")
            header.className = "modal-header"
            header.style.cssText = [
                "border-bottom:var(--aes-bw-1) solid var(--aes-oxide)",
                "padding:var(--aes-sp-4)",
                "position:relative"
            ].join(";")

            const heroBrand = document.createElement("div")
            heroBrand.style.cssText = "display:flex;gap:var(--aes-sp-3);align-items:center;"

            const logo = document.createElement("img")
            logo.src = chrome.runtime.getURL("images/AES-logo-128.png")
            logo.alt = "AES"
            logo.style.cssText = [
                "width:64px;height:64px",
                "border:var(--aes-bw-2) solid var(--aes-oxide)",
                "border-radius:var(--aes-radius)",
                "flex:0 0 auto"
            ].join(";")

            const titleWrap = document.createElement("div")
            titleWrap.style.cssText = "flex:1 1 auto;"

            const badge = document.createElement("span")
            badge.className = "aes-stamp"
            badge.textContent = "What's new"
            badge.style.cssText = "display:inline-block;margin-bottom:var(--aes-sp-2);"

            const title = document.createElement("h3")
            title.textContent = notes.title
            title.style.cssText = [
                "font-family:var(--aes-font-display)",
                "font-size:var(--aes-fs-h2)",
                "font-weight:var(--aes-fw-display)",
                "text-transform:uppercase",
                "letter-spacing:var(--aes-tracking-caps)",
                "color:var(--aes-oxide)",
                "margin:0 0 var(--aes-sp-1)",
                "line-height:var(--aes-lh-tight)"
            ].join(";")

            const versionLabel = document.createElement("p")
            versionLabel.textContent = this.#formatVersionLabel(version, notes.releaseDate)
            versionLabel.style.cssText = [
                "font-family:var(--aes-font-mono)",
                "font-size:var(--aes-fs-micro)",
                "color:var(--aes-slate)",
                "text-transform:uppercase",
                "letter-spacing:var(--aes-tracking-mono)",
                "margin:0"
            ].join(";")

            titleWrap.append(badge, title, versionLabel)

            if (notes.summary) {
                const summary = document.createElement("p")
                summary.textContent = notes.summary
                summary.style.cssText = [
                    "font-family:var(--aes-font-display)",
                    "font-size:var(--aes-fs-body)",
                    "color:var(--aes-oxide-2)",
                    "margin:var(--aes-sp-2) 0 0",
                    "line-height:var(--aes-lh-body)"
                ].join(";")
                titleWrap.append(summary)
            }

            heroBrand.append(logo, titleWrap)
            header.append(this.#closeButton, heroBrand)

            const body = document.createElement("div")
            body.className = "modal-body"
            body.style.cssText = "padding:var(--aes-sp-4);max-height:60vh;overflow:auto;"

            const sections = document.createElement("div")
            sections.style.cssText = "display:flex;flex-direction:column;gap:var(--aes-sp-4);"

            notes.sections.forEach(function (section) {
                const card = document.createElement("section")
                card.style.cssText = [
                    "padding:var(--aes-sp-3)",
                    "border:var(--aes-bw-1) solid var(--aes-oxide)",
                    "background:var(--aes-bone)"
                ].join(";")

                const sectionTitle = document.createElement("h4")
                sectionTitle.textContent = section.title
                sectionTitle.style.cssText = [
                    "font-family:var(--aes-font-display)",
                    "font-size:var(--aes-fs-h3)",
                    "font-weight:var(--aes-fw-display)",
                    "text-transform:uppercase",
                    "letter-spacing:var(--aes-tracking-caps)",
                    "color:var(--aes-oxide)",
                    "margin:0 0 var(--aes-sp-2)"
                ].join(";")

                const list = document.createElement("ul")
                list.style.cssText = [
                    "list-style:disc",
                    "padding-left:var(--aes-sp-4)",
                    "margin:0",
                    "color:var(--aes-oxide)",
                    "font-family:var(--aes-font-display)",
                    "font-size:var(--aes-fs-body)",
                    "line-height:var(--aes-lh-body)"
                ].join(";")

                section.items.forEach(function (item) {
                    const listItem = document.createElement("li")
                    listItem.textContent = item
                    listItem.style.marginBottom = "var(--aes-sp-1)"
                    list.append(listItem)
                })

                card.append(sectionTitle, list)
                sections.append(card)
            })
            body.append(sections)

            const footer = document.createElement("div")
            footer.className = "modal-footer"
            footer.style.cssText = [
                "border-top:var(--aes-bw-1) solid var(--aes-oxide)",
                "padding:var(--aes-sp-3) var(--aes-sp-4)",
                "display:flex",
                "justify-content:space-between",
                "align-items:center"
            ].join(";")

            const changelogLink = document.createElement("a")
            changelogLink.href = "https://github.com/NEWLY2014/AirlineSim-Enhancement-Suite/blob/main/CHANGELOG.md"
            changelogLink.target = "_blank"
            changelogLink.rel = "noopener noreferrer"
            changelogLink.textContent = "View full changelog"
            changelogLink.style.cssText = [
                "font-family:var(--aes-font-mono)",
                "font-size:var(--aes-fs-micro)",
                "text-transform:uppercase",
                "letter-spacing:var(--aes-tracking-mono)",
                "color:var(--aes-oxide)",
                "text-decoration:underline"
            ].join(";")

            footer.append(changelogLink, this.#confirmButton)
            content.append(header, body, footer)
            dialog.append(content)
            container.append(dialog)

            return container
        }

        #createBackdrop() {
            const backdrop = document.createElement("div")
            backdrop.className = "modal-backdrop fade in"
            backdrop.style.cssText = "z-index:1040;"
            return backdrop
        }

        #createCloseButton() {
            const button = document.createElement("button")
            button.setAttribute("type", "button")
            button.className = "btn btn-default aes-modal__close"
            button.setAttribute("aria-label", "Close")
            button.innerHTML = "&times;"
            button.style.cssText = [
                "position:absolute",
                "top:var(--aes-sp-2)",
                "right:var(--aes-sp-2)",
                "background:transparent",
                "border:0",
                "color:var(--aes-oxide)",
                "font-family:var(--aes-font-display)",
                "font-size:var(--aes-fs-h2)",
                "line-height:1",
                "padding:0 var(--aes-sp-2)",
                "cursor:pointer",
                "z-index:1"
            ].join(";")
            return button
        }

        #createConfirmButton() {
            const button = document.createElement("button")
            button.type = "button"
            button.className = "btn btn-primary"
            button.textContent = "Got it"
            button.style.cssText = [
                "background:var(--aes-oxide)",
                "color:var(--aes-bone)",
                "border:var(--aes-bw-2) solid var(--aes-oxide)",
                "border-radius:var(--aes-radius)",
                "font-family:var(--aes-font-display)",
                "font-size:var(--aes-fs-body)",
                "text-transform:uppercase",
                "letter-spacing:var(--aes-tracking-caps)",
                "padding:var(--aes-sp-2) var(--aes-sp-4)",
                "cursor:pointer"
            ].join(";")
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
            if (event.key === "Escape") {
                this.dismiss()
            }
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
            if (!releaseDate) {
                return "Version " + version
            }
            return "Version " + version + " - Released " + releaseDate
        }
    }

    function showDialog() {
        if (document.getElementById("aes-release-notes-dialog")) {
            return
        }
        const version = resolveVersion()
        const notes = RELEASE_NOTES[version]
        if (!notes) {
            return
        }
        new ReleaseNotesDialog(version, notes)
    }

    function maybeAutoShow() {
        if (window.top !== window.self) {
            return
        }
        const version = resolveVersion()
        if (!RELEASE_NOTES[version]) {
            return
        }
        chrome.storage.local.get([STORAGE_KEY], function (result) {
            if (result[STORAGE_KEY] === version) {
                return
            }
            showDialog()
        })
    }

    function ensureFooterLink() {
        const version = resolveVersion()
        if (!RELEASE_NOTES[version]) {
            return
        }
        const footerLine = document.querySelector(".as-footer-line")
        if (!footerLine || document.getElementById("aes-footer-version")) {
            return
        }
        const wrapper = document.createElement("div")
        wrapper.id = "aes-footer-version"
        wrapper.className = "as-footer-line-element version"

        const link = document.createElement("a")
        link.href = "#"
        link.className = "aes-footer-version-link"
        link.textContent = "AES: v" + version
        link.addEventListener("click", function (event) {
            event.preventDefault()
            showDialog()
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
        open: showDialog,
        ensureFooterLink
    }

    ensureFooterLink()
    maybeAutoShow()
})()
