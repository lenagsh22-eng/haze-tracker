/* Haze Tracker core: data fetching, PSI bands, settings storage and alert logic.
   Loaded by the page (<script>) and by the service worker (importScripts). */
(function (root) {
  'use strict';

  var API = {
    psi: 'https://api-open.data.gov.sg/v2/real-time/api/psi',
    pm25: 'https://api-open.data.gov.sg/v2/real-time/api/pm25'
  };

  var REGIONS = ['north', 'west', 'central', 'east', 'south'];

  // NEA PSI descriptors
  var PSI_BANDS = [
    { max: 50, key: 'good', label: 'Good' },
    { max: 100, key: 'moderate', label: 'Moderate' },
    { max: 200, key: 'unhealthy', label: 'Unhealthy' },
    { max: 300, key: 'very-unhealthy', label: 'Very unhealthy' },
    { max: Infinity, key: 'hazardous', label: 'Hazardous' }
  ];

  // NEA 1-hour PM2.5 concentration bands (ug/m3)
  var PM25_BANDS = [
    { max: 55, key: 'good', label: 'Normal' },
    { max: 150, key: 'unhealthy', label: 'Elevated' },
    { max: 250, key: 'very-unhealthy', label: 'High' },
    { max: Infinity, key: 'hazardous', label: 'Very high' }
  ];

  var DEFAULT_SETTINGS = { enabled: false, region: 'central', threshold: 100 };

  function band(bands, value) {
    if (typeof value !== 'number' || isNaN(value)) return null;
    for (var i = 0; i < bands.length; i++) {
      if (value <= bands[i].max) return bands[i];
    }
    return bands[bands.length - 1];
  }

  function psiBand(v) { return band(PSI_BANDS, v); }
  function pm25Band(v) { return band(PM25_BANDS, v); }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-SG', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore'
      }).format(new Date(iso));
    } catch (e) { return ''; }
  }

  // ---------- data ----------

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      if (!json || json.code !== 0 || !json.data || !json.data.items || !json.data.items.length) {
        throw new Error('Unexpected API response');
      }
      return json.data.items[json.data.items.length - 1];
    });
  }

  // Returns { psi: {region: n}, pm25: {region: n}, psiTime, pm25Time, fetchedAt }
  function fetchAll() {
    var psiP = getJson(API.psi);
    // The 1-hour PM2.5 feed is secondary: if it fails we still show PSI.
    var pmP = getJson(API.pm25).catch(function () { return null; });
    return Promise.all([psiP, pmP]).then(function (r) {
      var psiItem = r[0], pmItem = r[1];
      return {
        psi: (psiItem.readings && psiItem.readings.psi_twenty_four_hourly) || {},
        pm25: (pmItem && pmItem.readings && pmItem.readings.pm25_one_hourly) || {},
        psiTime: psiItem.timestamp || psiItem.updatedTimestamp || null,
        pm25Time: pmItem ? (pmItem.timestamp || pmItem.updatedTimestamp || null) : null,
        fetchedAt: Date.now()
      };
    });
  }

  // ---------- storage (IndexedDB so the service worker can read it too) ----------

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function kvGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function kvSet(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getSettings() {
    return kvGet('settings').then(function (s) {
      var out = {};
      for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
      if (s) for (var j in s) out[j] = s[j];
      return out;
    }).catch(function () {
      var out = {};
      for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
      return out;
    });
  }

  // Saving settings also records whether the current reading is already above
  // the threshold, so only real crossings trigger an alert afterwards.
  function saveSettings(settings, currentData) {
    var state = { sig: settings.region + ':' + settings.threshold, above: null };
    if (currentData && currentData.psi && typeof currentData.psi[settings.region] === 'number') {
      state.above = currentData.psi[settings.region] > settings.threshold;
    }
    return kvSet('settings', settings).then(function () { return kvSet('state', state); });
  }

  // ---------- alert logic ----------

  // Compares the latest reading with the stored state. Returns an alert
  // descriptor ({type: 'above'|'below', ...}) when the threshold was crossed
  // since the last check, otherwise null. Updates the stored state.
  function evaluateAlert(data) {
    return getSettings().then(function (s) {
      if (!s.enabled) return null;
      var value = data.psi[s.region];
      if (typeof value !== 'number') return null;
      var above = value > s.threshold;
      var sig = s.region + ':' + s.threshold;
      return kvGet('state').then(function (st) {
        var prev = st && st.sig === sig ? st.above : null;
        return kvSet('state', { sig: sig, above: above }).then(function () {
          if (prev === null || prev === above) return null; // first look, or no change
          return {
            type: above ? 'above' : 'below',
            region: s.region,
            value: value,
            threshold: s.threshold,
            time: data.psiTime
          };
        });
      });
    });
  }

  function alertContent(a) {
    var b = psiBand(a.value);
    var region = cap(a.region);
    if (a.type === 'above') {
      return {
        title: 'Haze alert: ' + region + ' PSI ' + a.value,
        body: '24-hr PSI (' + (b ? b.label : '') + ') is above your threshold of ' + a.threshold +
          (a.time ? '. Updated ' + fmtTime(a.time) + '.' : '.')
      };
    }
    return {
      title: 'Haze easing: ' + region + ' PSI ' + a.value,
      body: '24-hr PSI is back at or below your threshold of ' + a.threshold +
        (a.time ? '. Updated ' + fmtTime(a.time) + '.' : '.')
    };
  }

  function showAlert(registration, a) {
    var c = alertContent(a);
    return registration.showNotification(c.title, {
      body: c.body,
      icon: 'icons/icon-192.png',
      tag: 'psi-alert',
      renotify: true,
      data: { url: './' }
    });
  }

  root.Haze = {
    API: API, REGIONS: REGIONS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    psiBand: psiBand, pm25Band: pm25Band, cap: cap, fmtTime: fmtTime,
    fetchAll: fetchAll, getSettings: getSettings, saveSettings: saveSettings,
    evaluateAlert: evaluateAlert, alertContent: alertContent, showAlert: showAlert
  };
})(typeof self !== 'undefined' ? self : this);
