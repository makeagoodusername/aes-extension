const { performance } = require('perf_hooks');

// Mock chrome API
global.chrome = {
  storage: {
    local: {
      data: {},
      get: async function(keys) {
        if (keys === null) {
          // Deep clone to simulate Chrome API
          return JSON.parse(JSON.stringify(this.data));
        }
        const result = {};
        for (const k of keys) {
            if (this.data[k] !== undefined) result[k] = JSON.parse(JSON.stringify(this.data[k]));
        }
        return result;
      },
      getKeys: async function() {
          return Object.keys(this.data);
      },
      remove: async function(keys) {
          if (!Array.isArray(keys)) keys = [keys];
          for (const k of keys) delete this.data[k];
      },
      set: async function(items) {
          for (const k in items) this.data[k] = JSON.parse(JSON.stringify(items[k]));
      }
    }
  }
};
global.window = {};

function seedData() {
    console.log("Seeding large storage...");
    chrome.storage.local.data = {};
    for (let i = 0; i < 50000; i++) {
        chrome.storage.local.data[`unrelated:key:${i}`] = { a: 1, b: "test", c: [1, 2, 3], d: { nested: true } };
    }
    for (let i = 0; i < 50; i++) {
        chrome.storage.local.data[`routeAssistant:pricingApplyLog:HUB-DEST${i}`] = { a: 1 };
    }
    chrome.storage.local.data["routeAssistant:pricingApplyLog"] = { entries: [] };
    console.log("Seeding done. Total keys:", Object.keys(chrome.storage.local.data).length);
}

// Require the file
require('../../../modules/route-assistant/pricing-apply-log.js');

async function runBenchmark() {
    const log = new window.RouteAssistantPricingApplyLog();

    seedData();
    const start = performance.now();
    await log.clear();
    const end = performance.now();
    console.log(`Optimized clear() took ${(end - start).toFixed(2)}ms`);
}

runBenchmark();
