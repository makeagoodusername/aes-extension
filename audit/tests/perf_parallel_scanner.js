const assert = require('assert');

// Mock Dependencies
global.window = global;
global.chrome = { storage: { local: { get: async () => ({}) } } };

// Mock CountryScraper and DemandStore to bypass phase 2 safely
global.CountryScraper = {
    _getAllAirportsForCountry: async () => []
};
global.RouteAssistantDemandStore = {};
global.RouteAssistantCountryResolver = class {
    constructor() {}
    async resolve() { return { countryId: 1 }; }
};

// Load the module (this executes the IIFE)
require('../../modules/route-assistant/parallel-scanner.js');

class MockResolver {
    async resolve(iata) {
        // simulate a small delay to make the loop noticeable
        await new Promise(r => setTimeout(r, 10));
        return { countryId: 100 };
    }
}

async function runBenchmark() {
    console.log("Starting benchmark...");

    // Inject our mock resolver into a new scanner instance
    const scanner = new global.RouteAssistantParallelScanner({}, { concurrency: 3 });
    scanner.resolver = new MockResolver();

    const testIatas = Array.from({length: 300}, (_, i) => `A${String(i).padStart(2, '0')}`);

    const start = process.hrtime.bigint();
    const result = await scanner.run(testIatas);
    const end = process.hrtime.bigint();

    const timeMs = Number(end - start) / 1000000;
    console.log(`Phase 1 + 2 took ${timeMs.toFixed(2)} ms`);
    console.log(`Resolved: ${result.resolved}, Total: ${result.total}`);
}

runBenchmark().catch(console.error);
