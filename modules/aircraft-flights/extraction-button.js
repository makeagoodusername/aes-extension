class ExtractionButton {
    element
    label
    callback
    className
    type

    constructor(label, callback, className = "btn btn-default", type = "button") {
        this.label = label
        this.callback = callback
        this.className = className
        this.type = type

        this.element = this.#createElement()
    }
    
    #createElement() {
        const button = document.createElement("button")
        button.type = this.type
        button.innerText = this.label
        button.className = this.className
        // F-9228-802: wire the callback. Without this every button created
        // via this class is a no-op — `addButtons()` (the modernised path)
        // builds them but the click did nothing.
        if (typeof this.callback === "function") {
            button.addEventListener("click", (ev) => this.callback(ev, this))
        }
        return button
    }
}
