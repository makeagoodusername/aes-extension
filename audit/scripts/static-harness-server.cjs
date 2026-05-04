"use strict"

const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")

const root = path.resolve(__dirname, "../..")
const port = Number(process.argv[2]) || 8765

const mime = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
}

function resolveRequestPath(reqUrl) {
    const url = new URL(reqUrl || "/", "http://127.0.0.1")
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === "/") pathname = "/tools/dashboard-harness-t6.html"
    const target = path.normalize(path.join(root, pathname))
    if (target !== root && !target.startsWith(root + path.sep)) return null
    return target
}

const server = http.createServer((req, res) => {
    const target = resolveRequestPath(req.url)
    if (!target) {
        res.writeHead(403, {"content-type": "text/plain; charset=utf-8"})
        res.end("Forbidden")
        return
    }
    fs.readFile(target, (err, data) => {
        if (err) {
            res.writeHead(err.code === "ENOENT" ? 404 : 500, {"content-type": "text/plain; charset=utf-8"})
            res.end(err.code === "ENOENT" ? "Not found" : "Read failed")
            return
        }
        res.writeHead(200, {"content-type": mime[path.extname(target)] || "application/octet-stream"})
        res.end(data)
    })
})

server.listen(port, "127.0.0.1", () => {
    console.error("[harness-server] http://127.0.0.1:" + port)
})

function shutdown() {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
