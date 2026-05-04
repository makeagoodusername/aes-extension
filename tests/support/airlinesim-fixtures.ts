import type { BrowserContext } from "@playwright/test"

export async function installMockAirlineSimRoutes(ctx: BrowserContext) {
    await ctx.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: dashboardFixture()
        })
    })
    await ctx.route("https://free1.airlinesim.aero/app/finance/accounting**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: accountingFixture()
        })
    })
}

export function dashboardFixture() {
    return pageShell(`
    <main id="main-content">
      <section class="facts">
        <table>
          <tr><td>Airline</td><td>Casper Flight Logistics</td></tr>
          <tr><td>Code</td><td>CFL</td></tr>
          <tr><td>Company reputation</td><td>92</td></tr>
        </table>
      </section>
      <section id="enterprise-dashboard" class="as-page-dashboard">
        <h1>Enterprise Dashboard</h1>
      </section>
    </main>`)
}

export function accountingFixture() {
    return pageShell(`
    <main id="main-content">
      <section class="as-panel">
        <h1>Accounting</h1>
        <table><tbody><tr><td>Cash</td><td>1234567</td></tr></tbody></table>
      </section>
    </main>`)
}

function pageShell(body: string) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AirlineSim Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    .as-navbar-main { background: #233044; color: #fff; padding: 8px 12px; }
    .as-navbar-main a { color: inherit; text-decoration: none; }
    #as-navbar-main-collapse .navbar-nav { display: flex; gap: 12px; list-style: none; margin: 0; padding: 8px 12px; background: #f5f5f5; }
    #as-navbar-main-collapse a { color: #1b2733; text-decoration: none; }
    .as-navbar-bottom { padding: 6px 12px; border-bottom: 1px solid #ddd; }
    main { padding: 16px; }
    .facts table { border-collapse: collapse; }
    .facts td { border: 1px solid #ddd; padding: 4px 8px; }
  </style>
</head>
<body>
  <div class="as-navbar-main">
    <a class="name" href="/app/enterprise/dashboard"><span>Casper Flight Logistics</span><span class="caret"></span></a>
  </div>
  <nav id="as-navbar-main-collapse">
    <ul class="navbar-nav">
      <li><a href="/app/enterprise/dashboard">Dashboard</a></li>
      <li><a href="/app/fleets">Fleets</a></li>
      <li><a href="/app/com/scheduling/ICN">Scheduling</a></li>
      <li><a href="/app/com/numbers">Flight numbers</a></li>
      <li><a href="/app/enterprise/settings">Settings</a></li>
    </ul>
  </nav>
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-03 12:34 UTC</span></div>
  ${body}
</body>
</html>`
}
