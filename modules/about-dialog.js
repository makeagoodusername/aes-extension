class AboutDialog {
    #target
    #container
    #modalDialog
    #modalContent
    #closeButton
    #body

    constructor() {
        this.#closeButton = this.#createCloseButton()
        this.#body = this.#createBody()
        this.#body.prepend(this.#closeButton)
        this.#modalContent = this.#createModalContent()
        this.#modalContent.append(this.#body)
        this.#modalDialog = this.#createModalDialog()
        this.#modalDialog.append(this.#modalContent)
        this.#container = this.#createContainer()
        this.#container.append(this.#modalDialog)
        this.#target = this.#setTarget()
        this.#target.append(this.#container)

        const observer = this.#mutationObserver()
        observer.observe(this.#container, {attributes: true})
    }

    #createContainer() {
        const container = document.createElement("div")
        container.className = "modal"
        container.id = "aes-about-dialog"
        container.setAttribute("role", "dialog")
        container.setAttribute("aria-modal", "true")
        container.setAttribute("aria-hidden", "true")
        container.style = "display: none"

        return container
    }

    #createModalDialog() {
        const modalDialog = document.createElement("div")
        modalDialog.className = "modal-dialog modal-md"

        return modalDialog
    }

    /**
     * Modal frame — bone bg, 2px oxide border, sharp corners, no shadow.
     * Overrides Bootstrap's `.modal-content` defaults inline so we beat
     * AS's Bootstrap CSS specificity.
     */
    #createModalContent() {
        const modalContent = document.createElement("div")
        modalContent.className = "modal-content"
        modalContent.style.cssText = [
            "background:var(--aes-bone)",
            "color:var(--aes-oxide)",
            "border:var(--aes-bw-2) solid var(--aes-oxide)",
            "border-radius:var(--aes-radius)",
            "box-shadow:none",
            "font-family:var(--aes-font-display)"
        ].join(";")

        return modalContent
    }

    /**
     * Close button — corner placement, oxide on bone, hover to rust.
     */
    #createCloseButton() {
        const icon = document.createElement("span")
        icon.setAttribute("aria-hidden", "true")
        icon.innerText = "×"
        const label = document.createElement("span")
        label.innerText = "Close"
        label.className = "sr-only"

        const button = document.createElement("button")
        button.setAttribute("type", "button")
        button.dataset.dismiss = "modal"
        button.className = "btn btn-default aes-modal__close"
        button.style.cssText = [
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
        button.append(icon, label)

        return button
    }

    /**
     * Body — brutalist composition:
     *   - Logo with 2px oxide border (no radius)
     *   - "AIRLINESIM ENHANCEMENT SUITE" UPPERCASE display caps tracked
     *   - Mono version stamp (e.g. "v0.6.9-BETA")
     *   - Slate copyright caption
     */
    #createBody() {
        const body = document.createElement("div")
        body.className = "modal-body"
        body.style.cssText = [
            "padding:var(--aes-sp-5) var(--aes-sp-4) var(--aes-sp-4)",
            "text-align:center",
            "position:relative"
        ].join(";")

        const manifest = chrome.runtime.getManifest()
        const description = manifest.description
        const versionName = manifest.version_name
        let version = manifest.version
        if (versionName) {
            version = versionName
        }

        const logoUrl = chrome.runtime.getURL("images/AES-logo-128.png")

        body.innerHTML = `
            <img src="${logoUrl}"
                 alt="AES"
                 style="width:96px;height:96px;border-radius:var(--aes-radius);
                        border:var(--aes-bw-2) solid var(--aes-oxide);
                        display:block;margin:0 auto var(--aes-sp-4);">
            <h2 style="font-family:var(--aes-font-display);
                       font-size:var(--aes-fs-h1);
                       font-weight:var(--aes-fw-display);
                       text-transform:uppercase;
                       letter-spacing:var(--aes-tracking-caps);
                       color:var(--aes-oxide);
                       margin:0 0 var(--aes-sp-2);
                       line-height:var(--aes-lh-tight);">
                AirlineSim<br>Enhancement Suite
            </h2>
            <div style="display:flex;justify-content:center;margin:var(--aes-sp-3) 0;">
                <span class="aes-stamp">v${version}</span>
            </div>
            <p style="font-family:var(--aes-font-display);
                      font-size:var(--aes-fs-body);
                      color:var(--aes-oxide-2);
                      margin:var(--aes-sp-2) 0;
                      line-height:var(--aes-lh-body);">
                ${description || ""}
            </p>
            <hr class="aes-rule" style="margin:var(--aes-sp-4) 0 var(--aes-sp-2);">
            <p style="font-family:var(--aes-font-mono);
                      font-size:var(--aes-fs-micro);
                      color:var(--aes-slate);
                      text-transform:uppercase;
                      letter-spacing:var(--aes-tracking-mono);
                      margin:0;">
                © 2020-2024 AES Authors &nbsp; · &nbsp; MIT License
            </p>
        `

        return body
    }

    #setTarget() {
        const target = document.querySelector("body")
        return target
    }

    #mutationObserver() {
        const observer = new MutationObserver(this.#correctBootstrapBehaviour.bind(this))
        return observer
    }

    #correctBootstrapBehaviour() {
        if (this.#container.classList.contains("in") && !this.#container.classList.contains("modal")) {
            this.#container.classList.add("modal")
            this.#container.style = "display: block"
        }
    }
}

new AboutDialog()
