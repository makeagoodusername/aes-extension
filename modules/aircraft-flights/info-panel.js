/** Class representing an info panel */
class InfoPanel {
    #panel
    #tbody
    #rows
    #hubOverrideHandler
    #hubResetHandler

    constructor() {
        this.#rows = this.#createRows()

        this.#panel = document.querySelector(".as-page-aircraft .col-md-2 h3:first-child + .as-panel")
        this.#tbody = this.#panel.querySelector("tbody")
        // F-9228-805: idempotent mount. On a re-entry (extension reload, or
        // a future Wicket fragment re-render hitting the readyState gate)
        // strip prior AES rows before appending; without this the panel
        // would gain a duplicate ID + Registration row pair on every mount.
        for (const stale of this.#tbody.querySelectorAll('tr[data-aes-info-row]')) stale.remove()
        for (const row in this.#rows) {
            this.#rows[row].element.dataset.aesInfoRow = row
        }
        this.#addRows()
    }

    #createRows() {
        const rows = {
            id: new InfoPanelRow("ID"),
            registration: new InfoPanelRow("Registration"),
            // HUB rows ported from upstream AES v0.7.6 / v0.7.7. Auto-detected
            // HUB plus user-editable override; the "Current HUB" row resolves
            // override > detected so callers see the effective value at a
            // glance.
            hubDetected: new InfoPanelRow("Detected HUB"),
            hubOverride: new InfoPanelRow("Override HUB"),
            hubEffective: new InfoPanelRow("Current HUB"),
            hubControl: new HubOverrideRow(
                "HUB override",
                (value) => this.#hubOverrideHandler && this.#hubOverrideHandler(value),
                () => this.#hubResetHandler && this.#hubResetHandler()
            )
        }

        return rows
    }

    #addRows() {
        for (const row in this.#rows) {
            this.#tbody.append(this.#rows[row].element)
        }
    }

    set aircraftId(value) {
        this.#rows.id.value = value
    }

    set registration(value) {
        this.#rows.registration.value = value
    }

    set hubDetected(value) {
        this.#rows.hubDetected.value = value || "--"
    }

    set hubOverride(value) {
        this.#rows.hubOverride.value = value || "--"
        if (typeof this.#rows.hubControl.setInputValue === "function") {
            this.#rows.hubControl.setInputValue(value || "")
        }
    }

    set hubEffective(value) {
        this.#rows.hubEffective.value = value || "--"
    }

    onHubOverride(handler) {
        this.#hubOverrideHandler = handler
    }

    onHubReset(handler) {
        this.#hubResetHandler = handler
    }
}

class InfoPanelRow {
    #element
    #header
    #cell

    constructor(label, value, configuration) {
        this.#header = this.#createHeader(label)
        this.#cell = this.#createCell(value)
        this.#element = this.#createRow()
        this.#element.append(this.#header, this.#cell)
    }

    #createRow() {
        const row = document.createElement("tr")
        return row
    }

    #createHeader(label) {
        const header = document.createElement("th")
        header.innerText = label

        return header
    }

    #createCell(value) {
        const content = this.#getCellContent(value)
        const cell = document.createElement("td")
        cell.append(content)
        cell.className = "text-right"

        return cell
    }

    #getCellContent(value) {
        let content = value
        if (!value) {
            content = "--"
        }

        return content
    }

    get element() {
        return this.#element
    }

    set value(value) {
        const content = this.#getCellContent(value)
        this.#cell.innerHTML = null
        this.#cell.append(content)
    }
}

/**
 * Row that hosts an editable HUB override input plus Save / Reset buttons.
 * Upstream AES v0.7.6/0.7.7 placed this in a horizontal toolbar; current's
 * info panel is a vertical key/value list, so the input + buttons live in
 * the value cell.
 */
class HubOverrideRow {
    #element
    #header
    #cell
    #input
    #saveBtn
    #resetBtn

    constructor(label, onSave, onReset) {
        this.#header = document.createElement("th")
        this.#header.innerText = label

        this.#input = document.createElement("input")
        this.#input.type = "text"
        this.#input.className = "form-control input-sm"
        this.#input.maxLength = 4
        this.#input.placeholder = "IATA"
        this.#input.style.display = "inline-block"
        this.#input.style.width = "5em"

        this.#saveBtn = document.createElement("button")
        this.#saveBtn.type = "button"
        this.#saveBtn.className = "btn btn-default btn-xs"
        this.#saveBtn.innerText = "Save"
        this.#saveBtn.addEventListener("click", () => {
            const raw = (this.#input.value || "").trim().toUpperCase()
            if (typeof onSave === "function") onSave(raw)
        })

        this.#resetBtn = document.createElement("button")
        this.#resetBtn.type = "button"
        this.#resetBtn.className = "btn btn-default btn-xs"
        this.#resetBtn.innerText = "Reset"
        this.#resetBtn.addEventListener("click", () => {
            this.#input.value = ""
            if (typeof onReset === "function") onReset()
        })

        this.#cell = document.createElement("td")
        this.#cell.className = "text-right"
        this.#cell.append(this.#input, " ", this.#saveBtn, " ", this.#resetBtn)

        this.#element = document.createElement("tr")
        this.#element.append(this.#header, this.#cell)
    }

    get element() {
        return this.#element
    }

    setInputValue(value) {
        this.#input.value = value || ""
    }
}
