/**
 * Restructure slice A — ORS Sandbox view module.
 *
 * Sandbox view replaces the table with a per-route ORS pricing simulator
 * (price × frequency × comfort sliders → projected rank, share, pax/wk,
 * revenue/wk, profit/wk). Read-only against AS — the sandbox never
 * writes prices back; that's the Auto-Pricing T3 pipeline.
 *
 * Slice A delegates to the existing `_renderOrsSandbox` implementation;
 * the model + observation stores it depends on are unchanged.
 */
class RouteAssistantSandboxView {

    static get id() { return "sandbox" }
    static get label() { return "Sandbox" }

    static render(panel, sorted) {
        panel._renderOrsSandbox(sorted)
    }
}





class RouteAssistantSandboxSimulationModal {
    static show(panel, route) {
        if (!route || !route.orsByClass) return;

        // Dark overlay
        const overlay = document.createElement("div")
        overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:99999;display:flex;align-items:center;justify-content:center;"

        const modal = document.createElement("div")
        modal.style.cssText = "background:#1e293b;border:1px solid #334155;border-radius:6px;width:500px;max-width:90vw;padding:20px;color:#cbd5e1;box-shadow:0 10px 25px rgba(0,0,0,0.5);"

        const header = document.createElement("h3")
        header.textContent = "🧪 Inject Fictional Competitor"
        header.style.cssText = "margin:0 0 16px 0;color:#f8fafc;font-size:16px;border-bottom:1px solid #334155;padding-bottom:8px;"
        modal.append(header)

        const desc = document.createElement("p")
        desc.textContent = "Add a simulated competitor flight to the ORS cache to see how it affects your projected market share."
        desc.style.cssText = "font-size:12px;color:#94a3b8;margin-bottom:16px;"
        modal.append(desc)

        const form = document.createElement("div")
        form.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;"

        const fields = [
            { id: "fic_class", label: "Class", type: "select", options: ["Y", "C", "F"] },
            { id: "fic_price", label: "Price ($)", type: "number", val: "200" },
            { id: "fic_rating", label: "Rating", type: "number", val: "75" },
            { id: "fic_freq", label: "Weekly Freq", type: "number", val: "7" }
        ]

        const inputs = {}
        fields.forEach(f => {
            const wrap = document.createElement("div")
            const lbl = document.createElement("div")
            lbl.textContent = f.label
            lbl.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:4px;"
            wrap.append(lbl)

            let inp;
            if (f.type === "select") {
                inp = document.createElement("select")
                f.options.forEach(opt => {
                    const o = document.createElement("option")
                    o.value = opt; o.textContent = opt
                    inp.append(o)
                })
            } else {
                inp = document.createElement("input")
                inp.type = f.type
                inp.value = f.val
            }
            inp.style.cssText = "width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #475569;color:#f8fafc;padding:6px;border-radius:4px;"
            inputs[f.id] = inp
            wrap.append(inp)
            form.append(wrap)
        })
        modal.append(form)

        const btns = document.createElement("div")
        btns.style.cssText = "display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #334155;padding-top:16px;"

        const cancel = document.createElement("button")
        cancel.textContent = "Cancel"
        cancel.style.cssText = "background:transparent;border:1px solid #475569;color:#cbd5e1;padding:6px 12px;border-radius:4px;cursor:pointer;"
        cancel.onclick = () => overlay.remove()
        btns.append(cancel)

        const inject = document.createElement("button")
        inject.textContent = "Inject Competitor"
        inject.style.cssText = "background:#3b82f6;border:none;color:#fff;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:bold;"
        inject.onclick = () => {
            const cls = inputs["fic_class"].value
            const payloadKey = RouteAssistantOrsModel.CLASS_PAYLOAD[cls]
            if (route.orsByClass[payloadKey] && Array.isArray(route.orsByClass[payloadKey].connections)) {
                // Generate X rows based on frequency
                const freq = parseInt(inputs["fic_freq"].value) || 1
                const price = parseFloat(inputs["fic_price"].value) || 200
                const rating = parseFloat(inputs["fic_rating"].value) || 75

                for(let i=0; i<freq; i++) {
                    route.orsByClass[payloadKey].connections.push({
                        rating: rating,
                        totalPrice: price,
                        bookable: true,
                        legs: [{isOurs: false, flightCode: "FIC" + Math.floor(Math.random()*1000)}],
                        _synthetic: true,
                        _fictional: true
                    })
                }

                // Trigger panel recompute
                panel._recomputeOrsSandbox()
            }
            overlay.remove()
        }
        btns.append(inject)

        modal.append(btns)
        overlay.append(modal)
        document.body.append(overlay)
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantSandboxSimulationModal = RouteAssistantSandboxSimulationModal
    window.RouteAssistantSandboxView = RouteAssistantSandboxView
}
