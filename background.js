// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';
//Functions
function setDefaultSettings(){
  //Add default settings

  let aesSettings = {
    invPricing:setDefaultInvPricingSettings(),
    general:setDefaultGeneralSettings(),
    schedule:setDefaultScheduleSettings(),
    stationAutomation:setDefaultStationAutomationSettings(),
    usedAircraftScanner:setDefaultUsedAircraftScannerSettings()
  };
  chrome.storage.local.get(['settings'], function(result) {
    let settings = result.settings;
    if(!settings){
      settings = aesSettings;
      chrome.storage.local.set({settings: aesSettings}, function() {
        
      });
    }
  });
  //
}

function setDefaultScheduleSettings(){
  //auto settings
  let schedule = {
    autoExtract:0
  };
  //Cmp setttings
  return schedule;
}
function setDefaultStationAutomationSettings(){
  // Thresholds offered in the demand dropdowns (0 = ignore)
  let thresholds = [0, 1000, 5000, 10000, 50000, 100000, 500000, 1000000];
  let stationAutomation = {
    defaultPaxThreshold: 0,
    defaultCargoThreshold: 0,
    thresholds: thresholds,
    countriesCache: {}
  };
  return stationAutomation;
}
function setDefaultUsedAircraftScannerSettings(){
  // Used Aircraft Scanner — sub-dashboard that walks the AS used aircraft
  // market across many types in parallel and aggregates the offers.
  return {
    presets: [],
    typeFamilyOverrides: {},
    concurrency: 6,
    staggerMs: 2000,
    lastScanId: null
  };
}
function setDefaultGeneralSettings(){
  //auto settings
  let general = {
    defaultDashboard:'general'
  };
  //Cmp setttings
  return general;
}
function setDefaultInvPricingSettings(){
  //auto settings
  let invPricing = {
    autoAnalysisSave:1,
    autoPriceUpdate:0,
    autoClose:0,
    recommendation:{},
    historyTable:{
      showNow:1,
      showOnlyPricing:0,
      numberOfDates:"5"
    }
  };
  //Cmp setttings
  let steps = [
    {
      min:0,
      max:40,
      name:'Drop High',
      step:-8
    },
    {
      min:40,
      max:60,
      name:'Drop Medium',
      step: -4
    },
    {
      min:60,
      max:70,
      name:'Drop Low',
      step: -2
    },
    {
      min:70,
      max:80,
      name:'Keep',
      step: 0
    },
    {
      min:80,
      max:90,
      name:'Raise Low',
      step: 1
    },
    {
      min:90,
      max:99,
      name:'Raise Medium',
      step: 2
    },
    {
      min:99,
      max:100,
      name:'Raise High',
      step: 5
    }
  ];
  let cmps = ['Y','C','F','Cargo'];
  cmps.forEach(function(cmp){
    invPricing.recommendation[cmp] = {
      maxPrice:200,
      minPrice:60,
      steps:steps
    };
  });
  return invPricing;
}


//MAIN

chrome.runtime.onInstalled.addListener(function() {
  setDefaultSettings();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, function() {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({
        pageUrl: {hostContains: '.airlinesim.aero'},
      })],
      actions: [new chrome.declarativeContent.ShowPageAction()]
    }]);
  });
});
