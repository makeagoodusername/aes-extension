# Managing Routes Recon

## Manifest Match

- Add `modules/managing-routes/host.js` to the existing dashboard content-script block.
- Match pattern: `https://*.airlinesim.aero/app/enterprise/dashboard*`.
- The route-management view is a dashboard pane selected by `#aes-select-dashboard-main[value="routeManagement"]`; external links can request it with `#aes-section=routeManagement`.

## Mount Point

- Primary mount selector: `#aes-div-dashboard-routeManagement`.
- Insert host: `#aes-managing-routes-panel-host[data-aes-feature="managing-routes"]`.
- Preferred placement: before `#aes-div-routeManagement`, so RoutePanel appears above the route table and below the pane controls.
- Fallback: append to `#aes-div-dashboard-routeManagement` if the table wrapper has not been rendered yet.

## Selection Detection

- The selected route is inferred from the route-management table because the legacy pane has no URL param or app state object for active selection.
- Primary row selector: `#aes-table-routeManagement tbody tr`.
- Route key source: row id `aes-row-<origin><destination>`, for example `aes-row-FRAJFK`.
- Fallback cell sources: `.aes-od`, `.aes-origin`, `.aes-destination`, `.aes-direction`.
- Selection changes are detected through delegated `click` and checkbox `change` events on `#aes-div-dashboard-routeManagement`.
- Programmatic list commands are consumed from `ROUTE_COMMAND`; in-panel mutations are consumed from `ROUTE_PANEL_ACTION`.

## Navigation Model

- The AirlineSim dashboard is not a full SPA route for this pane. The legacy dropdown empties and rebuilds `#aes-div-dashboard`.
- The host uses a `MutationObserver` plus `hashchange`, `popstate`, `history.pushState`, and `history.replaceState` hooks to remount after pane switches or route-table rebuilds.

## Reused AES Utilities

- `AES.getServerName()`
- `AES.getAirlineCode()`
- `AES.getAirlineIdentity()`
- `window.__aesAccountId` from `AesAccountRegistry.bootstrapFromPage()`
- `AesDataBus.on()`, `AesDataBus.emit()`, and `AesDataBus.register()`
