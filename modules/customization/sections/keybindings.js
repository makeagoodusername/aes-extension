"use strict";

/**
 * Studio §07 — Keybindings.
 *
 * Renders every action from the shortcut registry as a row with the
 * action label on the left and an editable keys cell on the right.
 * Click the cell to enter chord-capture mode (see widgets/chord-capture).
 * Conflict detection runs after every change; conflicting rows show a
 * crimson note offering "Override existing" / "Cancel".
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioKeybindingsSection) return;

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const reg = window.AESShortcutRegistry;
        const store = window.AESCustomizationStore;
        const capture = window.AESStudioChordCapture;

        // Header row
        const header = document.createElement("div");
        header.style.cssText = headerStyle(T);
        const lh = document.createElement("span"); lh.textContent = "ACTION";
        const rh = document.createElement("span"); rh.textContent = "BINDING";
        header.append(lh, rh);
        host.appendChild(header);

        const tbl = document.createElement("div");
        tbl.style.cssText = "border-left:" + T.geom.bw1 + " solid " + T.color.paperRule + ";border-right:" + T.geom.bw1 + " solid " + T.color.paperRule;
        host.appendChild(tbl);

        function paintRows() {
            tbl.textContent = "";
            const items = reg.resolved();
            const conflicts = reg.conflicts(items);
            const conflictMap = Object.create(null);
            for (const c of conflicts) conflictMap[c.id] = c.conflictsWith;

            for (const sc of items) {
                tbl.appendChild(buildRow(T, sc, conflictMap[sc.id], store, capture, paintRows));
            }
        }
        paintRows();
        if (store) store.subscribe(paintRows);

        // Footer
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:" + T.sp[2] + ";margin-top:" + T.sp[3];
        actions.appendChild(button(T, "Reset all to defaults", function () {
            if (store) store.patch({ shortcuts: "__CLEAR__" });
        }));
        host.appendChild(actions);

        const note = document.createElement("div");
        note.style.cssText = [
            "margin-top:" + T.sp[4],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.slate,
            "line-height:1.5"
        ].join(";");
        note.textContent = "Click any binding cell to rebind. Esc cancels capture. Vim-style chords (g d) auto-complete after the second key or 800ms timeout. Single keys (/, ?) bind on first press.";
        host.appendChild(note);
    }

    function headerStyle(T) {
        return [
            "display:grid",
            "grid-template-columns:1fr 200px",
            "gap:" + T.sp[2],
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "font-weight:700",
            "color:" + T.color.oxide2,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps
        ].join(";");
    }

    function buildRow(T, sc, conflictWithId, store, capture, paintRows) {
        const row = document.createElement("div");
        row.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr 200px",
            "gap:" + T.sp[2],
            "padding:" + T.sp[2] + " " + T.sp[3],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "align-items:center",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "background:" + (conflictWithId ? "var(--aes-crimson-soft)" : T.color.bone)
        ].join(";");

        const left = document.createElement("div");
        const id = document.createElement("div");
        id.textContent = sc.desc;
        id.style.cssText = "color:" + T.color.oxide + ";font-weight:500";
        const meta = document.createElement("div");
        meta.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + T.color.slate + ";letter-spacing:" + T.track.mono;
        if (conflictWithId) {
            meta.style.color = "var(--aes-crimson)";
            meta.textContent = "CONFLICT — also bound: " + conflictWithId;
        } else {
            meta.textContent = sc.id + (sc.keys !== sc.defaultKeys ? "  ·  rebound" : "");
        }
        left.append(id, meta);
        row.appendChild(left);

        const right = document.createElement("div");
        right.style.cssText = "display:flex;gap:" + T.sp[1] + ";align-items:center;justify-content:flex-end";
        const cell = document.createElement("button");
        cell.type = "button";
        cell.textContent = sc.keys || "—";
        cell.style.cssText = bindingCellStyle(T, sc.disabled);
        cell.addEventListener("click", function (e) {
            e.preventDefault();
            if (!capture) return;
            capture.begin(cell, function (chord) {
                if (store) store.setShortcut(sc.id, chord, false);
            });
        });
        right.appendChild(cell);

        if (sc.keys !== sc.defaultKeys) {
            const reset = document.createElement("button");
            reset.type = "button";
            reset.textContent = "↺";
            reset.title = "Reset to default (" + sc.defaultKeys + ")";
            reset.style.cssText = [
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "background:" + T.color.bone,
                "color:" + T.color.oxide,
                "padding:" + T.sp[1],
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.body,
                "cursor:pointer",
                "min-width:24px"
            ].join(";");
            reset.addEventListener("click", function (e) {
                e.preventDefault();
                if (store) store.setShortcut(sc.id, null);
            });
            right.appendChild(reset);
        }

        row.appendChild(right);
        return row;
    }

    function bindingCellStyle(T, disabled) {
        return [
            "min-width:120px",
            "text-align:center",
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + (disabled ? T.color.bone3 : T.color.bone),
            "color:" + T.color.oxide,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono,
            "cursor:pointer"
        ].join(";");
    }

    function button(T, label, onClick) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:700",
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
        b.addEventListener("click", function (e) { e.preventDefault(); onClick(); });
        return b;
    }

    window.AESStudioKeybindingsSection = { render };
})();
