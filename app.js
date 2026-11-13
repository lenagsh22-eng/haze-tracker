(function () {
  'use strict';

  var H = window.Haze;
  var POLL_MS = 5 * 60 * 1000;
  var STALE_MS = 2 * 60 * 1000;
  var CACHE_KEY = 'haze-last-data';

  var data = null;          // latest readings
  var settings = null;      // alert settings
  var offline = false;
  var swReg = null;
  var installPrompt = null;

  function $(id) { return document.getElementById(id); }
  function num(v) { return typeof v === 'number' && !isNaN(v) ? v : null; }

  // ---------- rendering ----------

  function metricHtml(label, value, b, unit) {
    var cls = b ? ' band-' + b.key : '';
    var v = value === null ? '&ndash;' : String(value) + (unit ? '<small> ' + unit + '</small>' : '');
    return '<div class="metric' + cls + '">' +
      '<span class="m-label">' + label + '</span>' +
      '<span class="m-value">' + v + '</span>' +
      '<span class="m-band">' + (b ? b.label : 'No data') + '</span></div>';
  }

  function renderRegions() {
    var list = $('regions');
    var html = '';
    H.REGIONS.forEach(function (r) {
      var psi = data ? num(data.psi[r]) : null;
      var pm = data ? num(data.pm25[r]) : null;
      var selected = settings && settings.enabled && settings.region === r;
      html += '<li class="region' + (selected ? ' selected' : '') + '">' +
        '<div class="region-head"><h3>' + H.cap(r) + '</h3>' +
        (selected ? '<span class="pill">Alert region</span>' : '') + '</div>' +
        '<div class="metrics">' +
        metricHtml('24-hr PSI', psi, H.psiBand(psi), '') +
        metricHtml('1-hr PM2.5', pm, H.pm25Band(pm), '&micro;g/m&sup3;') +
        '</div></li>';
    });
    list.innerHTML = html;
  }

  function renderUpdated() {
    var el = $('updated');
    if (!data) { el.textContent = 'Loading…'; return; }
    var t = H.fmtTime(data.psiTime);
    el.textContent = (t ? 'PSI updated ' + t + ' SGT' : 'Updated') + (offline ? ' · offline' : '');
  }

  function showBanner(msg) {
    var b = $('banner');
    b.textContent = msg || '';
    b.hidden = !msg;
  }

  function render() {
    renderRegions();
    renderUpdated();
    if (offline) {
      showBanner(data
        ? "Can't reach NEA's data right now. Showing the last reading."
        : "Couldn't load PSI data. Check your connection and try again.");
    } else {
      showBanner('');
    }
  }

  // ---------- data ----------

  function loadCached() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { /* ignore */ }
  }

  function canNotify() {
    return 'Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator;
  }

  function checkAlert(d) {
    return H.evaluateAlert(d).then(function (alert) {
      if (alert && canNotify()) {
        return navigator.serviceWorker.ready.then(function (reg) { return H.showAlert(reg, alert); });
      }
    }).catch(function () { /* storage or notification problem: ignore */ });
  }

  function refresh() {
    var btn = $('refresh');
    btn.disabled = true;
    btn.classList.add('spin');
    return H.fetchAll().then(function (d) {
      data = d;
      offline = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
      render();
      return checkAlert(d);
    }).catch(function () {
      offline = true;
      render();
    }).then(function () {
      btn.disabled = false;
      btn.classList.remove('spin');
    });
  }

  // ---------- alert settings ----------

  function setStatus(msg) { $('alert-status').textContent = msg || ''; }

  function clampThreshold(v) {
    v = Math.round(Number(v));
    if (isNaN(v)) return H.DEFAULT_SETTINGS.threshold;
    return Math.max(0, Math.min(500, v));
  }

  function updateThresholdHint() {
    var t = clampThreshold($('threshold').value);
    var b = H.psiBand(t + 1);
    $('threshold-hint').textContent = 'Alerts start at PSI ' + (t + 1) + (b ? ' (' + b.label + ' range).' : '.');
  }

  function fillForm() {
    $('region').value = settings.region;
    $('threshold').value = settings.threshold;
    $('threshold-range').value = Math.min(300, settings.threshold);
    $('enabled').checked = !!settings.enabled;
    updateThresholdHint();
  }

  // Resolves true when notifications are allowed; otherwise explains why.
  function ensurePermission() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setStatus("This browser can't show notifications here. On iPhone, add the app to your Home Screen first and open it from there.");
      return Promise.resolve(false);
    }
    if (Notification.permission === 'granted') return Promise.resolve(true);
    if (Notification.permission === 'denied') {
      setStatus('Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.');
      return Promise.resolve(false);
    }
    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') setStatus('Notifications were not allowed, so alerts are off.');
      return p === 'granted';
    });
  }

  function syncBackgroundCheck(enabled) {
    if (!swReg || !('periodicSync' in swReg)) return Promise.resolve(false);
    if (!enabled) {
      return swReg.periodicSync.unregister('psi-check').then(function () { return false; }, function () { return false; });
    }
    return navigator.permissions.query({ name: 'periodic-background-sync' }).then(function (p) {
      if (p.state !== 'granted') return false;
      return swReg.periodicSync.register('psi-check', { minInterval: 60 * 60 * 1000 }).then(function () { return true; });
    }).catch(function () { return false; });
  }

  function onSave(e) {
    e.preventDefault();
    var s = {
      enabled: $('enabled').checked,
      region: $('region').value,
      threshold: clampThreshold($('threshold').value)
    };
    setStatus('');
    var step = s.enabled ? ensurePermission() : Promise.resolve(true);
    step.then(function (ok) {
      if (!ok) { s.enabled = false; $('enabled').checked = false; }
      return H.saveSettings(s, data).then(function () {
        settings = s;
        fillForm();
        renderRegions();
        return syncBackgroundCheck(s.enabled);
      }).then(function (bg) {
        if (!s.enabled) {
          if (ok) setStatus('Saved. Alerts are off.');
          return;
        }
        setStatus("Saved. You'll be notified when " + H.cap(s.region) + ' PSI goes above ' + s.threshold + '. ' +
          (bg ? 'Background checks are on (about hourly, when your phone allows).'
              : 'Keep the app open to receive alerts; background checks aren’t available on this device.'));
      });
    });
  }

  function onTest() {
    setStatus('');
    ensurePermission().then(function (ok) {
      if (!ok) return;
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.showNotification('Haze Tracker', {
          body: 'Notifications are working.',
          icon: 'icons/icon-192.png',
          tag: 'psi-test'
        });
      }).then(function () { setStatus('Test notification sent.'); });
    }).catch(function () {
      setStatus("Couldn't show a notification. Check that notifications are allowed for this app in your phone settings.");
    });
  }

  // ---------- install ----------

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function setupInstall() {
    if (isStandalone()) return;
    if (isIos()) {
      $('install').hidden = false;
      $('install-ios').hidden = false;
    }
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      installPrompt = e;
      $('install').hidden = false;
      $('install-android').hidden = false;
    });
    window.addEventListener('appinstalled', function () {
      $('install').hidden = true;
      installPrompt = null;
    });
    $('install-btn').addEventListener('click', function () {
      if (!installPrompt) return;
      installPrompt.prompt();
      installPrompt.userChoice.then(function () {
        installPrompt = null;
        $('install').hidden = true;
      });
    });
  }

  // ---------- start ----------

  function init() {
    loadCached();
    render();
    setupInstall();

    $('refresh').addEventListener('click', refresh);
    $('alert-form').addEventListener('submit', onSave);
    $('test-notif').addEventListener('click', onTest);
    $('threshold').addEventListener('input', function () {
      var v = clampThreshold($('threshold').value);
      $('threshold-range').value = Math.min(300, v);
      updateThresholdHint();
    });
    $('threshold-range').addEventListener('input', function () {
      $('threshold').value = $('threshold-range').value;
      updateThresholdHint();
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(function (reg) { swReg = reg; }).catch(function () {});
    }

    H.getSettings().then(function (s) {
      settings = s;
      fillForm();
      renderRegions();
    });

    refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && (!data || Date.now() - data.fetchedAt > STALE_MS)) refresh();
    });
  }

  init();
})();
