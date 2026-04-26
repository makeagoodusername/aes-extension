"use strict";

/**
 * Station-opening worker.
 *
 * Runs on the AirlineSim "open station" page. If a station-automation run is
 * in progress, this script fills in the station form for the next pending
 * station, submits it, and (on return) advances the queue by navigating to
 * the next station's open URL. When all queued countries have been processed
 * it flips `running` off and returns to the dashboard.
 *
 * The AS form selectors and success-detection logic are stubbed — they must
 * be filled in once the live AirlineSim page is inspected. See `TODO` markers.
 */

window.addEventListener("load", async () => {
    const server = AES.getServerName();
    const airlineCode = AES.getAirlineCode().code;
    const record = await StationAutomationStorage.load(server, airlineCode);
    if (!record.running) {
        return;
    }

    const iata = getStationIataFromUrl() || record.resolvedStations[record.currentStationIdx];
    if (!iata) {
        await finishRun(record, "No station code in URL and queue position invalid.");
        return;
    }

    const exceptionsSet = new Set(
        (record.queue[record.currentEntry]?.exceptions || []).map(c => c.toUpperCase())
    );

    let outcome;
    if (exceptionsSet.has(iata.toUpperCase())) {
        outcome = {status: "skipped", detail: "Listed as an exception."};
    } else if (alreadyOpenedOnPage()) {
        outcome = {status: "skipped", detail: "Station already opened."};
    } else {
        outcome = await attemptOpenStation(iata);
    }

    record.log.push({iata: iata, status: outcome.status, detail: outcome.detail});
    record.processedStations.push(iata);
    record.currentStationIdx += 1;
    await StationAutomationStorage.save(record);

    await advanceQueue(record, server, airlineCode);
});

/**
 * Extracts the IATA code from the current URL so the worker knows which
 * station this page is for. Relies on the `?code=XXX` parameter set by
 * `buildStationOpenUrl()` in content_dashboard.js.
 */
function getStationIataFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code") || params.get("airport") || params.get("iata");
    return code ? code.toUpperCase() : null;
}

/**
 * Best-effort check: looks for a signal on the page that the station is
 * already part of the airline's network, to avoid re-submitting the form.
 *
 * TODO: replace with the real selector once the open-station page is known.
 */
function alreadyOpenedOnPage() {
    const marker = document.querySelector("[data-aes-station-opened]"); // TODO
    return Boolean(marker);
}

/**
 * Fill and submit the "open station" form. Resolves once either:
 *   - the browser has navigated away (successful submit), OR
 *   - a server-side error message is detected on the same page.
 *
 * TODO (AS discovery):
 *   1. Replace the form/input selectors below with the actual ones on the
 *      AS open-station page.
 *   2. Decide on the success/error detection strategy. Most AS forms
 *      trigger a full page navigation, so the simple path is: submit and
 *      let the new page load — the next run of this content script will
 *      advance the queue.
 */
async function attemptOpenStation(iata) {
    const form = document.querySelector("form[name='openStation'], form[action*='station']"); // TODO confirm
    if (!form) {
        return {status: "failed", detail: "Open-station form not found on page."};
    }

    const codeInput = form.querySelector("input[name='code'], input[name='airport'], input[name='iata']"); // TODO confirm
    if (codeInput) {
        codeInput.value = iata;
    }

    const submit = form.querySelector("button[type='submit'], input[type='submit']");
    if (!submit) {
        return {status: "failed", detail: "Submit button not found."};
    }

    submit.click();
    // Navigation unloads this page; the follow-up load runs through `advanceQueue`
    // on the next station URL rather than from here.
    return {status: "ok", detail: "Submitted."};
}

/**
 * Decides which URL to navigate to next, based on current queue progress.
 */
async function advanceQueue(record, server, airlineCode) {
    // More stations in the current country?
    if (record.currentStationIdx < record.resolvedStations.length) {
        const next = record.resolvedStations[record.currentStationIdx];
        window.location.assign(buildStationOpenUrl(server, next));
        return;
    }

    // Current country done — move to the next in the queue.
    record.currentEntry += 1;
    record.currentStationIdx = 0;
    record.resolvedStations = [];
    await StationAutomationStorage.save(record);

    if (record.currentEntry >= record.queue.length) {
        await finishRun(record, null);
        return;
    }

    // Resolve the next country's station list.
    try {
        record.resolvedStations = await CountryScraper.resolveStations(
            record.queue[record.currentEntry], server
        );
    } catch (error) {
        record.log.push({
            iata: "-",
            status: "failed",
            detail: "Could not resolve stations for " + record.queue[record.currentEntry].country + ": " + error.message
        });
        await StationAutomationStorage.save(record);
        await finishRun(record, null);
        return;
    }

    if (!record.resolvedStations.length) {
        record.log.push({
            iata: "-",
            status: "skipped",
            detail: "No stations matched filter for " + record.queue[record.currentEntry].country
        });
        await StationAutomationStorage.save(record);
        await advanceQueue(record, server, airlineCode);
        return;
    }

    await StationAutomationStorage.save(record);
    window.location.assign(buildStationOpenUrl(server, record.resolvedStations[0]));
}

async function finishRun(record, failureDetail) {
    record.running = 0;
    if (failureDetail) {
        record.log.push({iata: "-", status: "failed", detail: failureDetail});
    }
    await StationAutomationStorage.save(record);
    window.location.assign(
        "https://" + AES.getServerName() + ".airlinesim.aero/app/enterprise/dashboard"
    );
}

/**
 * Mirror of the helper in content_dashboard.js. Kept local so this script
 * stays independent of the dashboard bundle.
 *
 * TODO (AS discovery): replace with the real station-opening URL template.
 */
function buildStationOpenUrl(server, iata) {
    return "https://" + server + ".airlinesim.aero/app/network/stations/open?code=" + encodeURIComponent(iata);
}
