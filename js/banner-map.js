// Records each sign a member measures in the Google Sheet ("banners" tab).
//
// After a successful scan the member pins the sign's location on a map; the
// record (size, location, scan photo) is saved straight away, and updated with
// the sign type, font type and tax when they calculate. Signs typed in by hand
// are saved when calculated, and can be pinned from the card above the form.
// The map is Esri's street map and satellite imagery through Leaflet, loaded the first time it opens;
// every saved record also gets a Google Maps link to the pin.
(function () {
  'use strict';

  var LEAFLET = 'assets/vendor/leaflet/';
  var START = { center: [13.2, 101.0], zoom: 6 };  // all of Thailand, when the location is unknown
  var PIN_ZOOM = 18;
  var MIN_ZOOM = 16;            // closer than this, the pin could be a street away from the sign
  var SAVE_TIMEOUT = 45000;     // the first save carries the photo
  var ADDRESS_WAIT = 2500;
  var TILES = {
    // Esri's tiles load from any page, including one opened as a local file; OpenStreetMap's
    // own tile servers block requests that do not name a website.
    map: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', native: 19,
      attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    },
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', native: 18,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
    }
  };

  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function msg() { return window.I18N_MESSAGES[root.lang === 'en' ? 'en' : 'th'].pin; }
  function auth() { return window.SignageAuth; }

  /* ---------- The sign being recorded ---------- */
  var record = null;

  function newRecord(source, width, length, photo) {
    var c = auth() && auth().customer();
    return {
      customerId: c ? c.id : '', id: '', source: source, scanW: width || 0, scanL: length || 0, photo: photo || '',
      lat: null, lng: null, address: '', note: '', calc: null, savedKey: '', status: ''
    };
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }
  function coordText(lat, lng) { return lat.toFixed(6) + ', ' + lng.toFixed(6); }
  function mapsUrl(lat, lng) { return 'https://www.google.com/maps?q=' + lat.toFixed(6) + ',' + lng.toFixed(6); }

  /* ---------- Card above the calculator ---------- */
  var card = $('pinCard');

  function render() {
    var m = msg();
    var r = record;
    var pinned = !!(r && r.lat != null);
    card.dataset.state = pinned ? 'pinned' : r && r.source === 'scan' ? 'needed' : 'empty';
    $('pinText').textContent = pinned ? (r.address || coordText(r.lat, r.lng)) : r && r.source === 'scan' ? m.needed : m.empty;
    $('pinCoords').hidden = !pinned;
    $('pinCoords').textContent = pinned ? coordText(r.lat, r.lng) + (r.note ? ' · ' + r.note : '') : '';
    $('pinGmaps').hidden = !pinned;
    if (pinned) $('pinGmaps').href = mapsUrl(r.lat, r.lng);
    $('pinBtnText').textContent = pinned ? m.change : m.pin;
    $('pinLocate').setAttribute('aria-label', m.myLocation);
    $('pinLocate').title = m.myLocation;

    var status = $('pinStatus');
    status.textContent = '';
    status.className = 'pin-card__status';
    status.hidden = !(r && r.status);
    if (!status.hidden) {
      status.classList.add('is-' + r.status);
      var text = document.createElement('span');
      text.textContent = r.status === 'saving' ? m.saving : r.status === 'saved' ? m.saved(r.id) : m.failed;
      status.appendChild(text);
      if (r.status === 'failed') {
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'pin-card__retry';
        retry.textContent = m.retry;
        retry.addEventListener('click', function () { r.savedKey = ''; save(); });
        status.appendChild(retry);
      }
    }
  }

  /* ---------- Saving to the Google Sheet ---------- */
  var busy = false;
  var again = false;

  function payload(r) {
    var w = r.calc ? r.calc.width : r.scanW;
    var l = r.calc ? r.calc.length : r.scanL;
    if (!(w > 0 && l > 0)) return null; // nothing worth a record yet
    return {
      bannerId: r.id,
      width: w,
      length: l,
      signType: r.calc ? r.calc.signType : '',
      fontType: r.calc ? r.calc.fontType : '',
      measuredBy: r.source === 'scan' ? (w === r.scanW && l === r.scanL ? 'scan' : 'scan_edited') : 'manual',
      lat: r.lat == null ? '' : r.lat,
      lng: r.lng == null ? '' : r.lng,
      address: r.address,
      note: r.note
    };
  }

  function save() {
    var r = record;
    var member = auth() && auth().customer();
    if (!r || !member) return;
    if (r.customerId !== member.id) { record = null; render(); return; } // someone else signed in
    if (busy) { again = true; return; }
    var body = payload(r);
    if (!body) return;
    var key = JSON.stringify(Object.assign({}, body, { bannerId: undefined }));
    if (key === r.savedKey) return;
    if (!r.id && r.photo) body.photo = r.photo;

    busy = true;
    r.status = 'saving';
    render();
    auth().call('saveBanner', body, SAVE_TIMEOUT).then(function (res) {
      r.id = res.bannerId;
      r.photo = '';
      r.savedKey = key;
      r.status = 'saved';
    }, function (err) {
      r.status = 'failed';
      if (err.code === 'not_found') r.id = ''; // the row was removed from the sheet: save it again as new
      if (err.code === 'bad_request' && window.console) {
        console.warn('Signage Tax: the Google Apps Script cannot save signs yet. Paste the latest google-apps-script/Code.gs and deploy a new version.');
      }
    }).then(function () {
      busy = false;
      if (record === r) render();
      if (again) { again = false; save(); }
    });
  }

  /* ---------- Map dialog ---------- */
  var dialog = $('pinMap');
  var stage = dialog.querySelector('.pinmap__stage');
  var map = null;
  var layers = {};
  var layerName = 'map';
  var me = null;            // the member's GPS position on the map
  var leaflet = null;
  var lastView = null;      // where the previous pin went, for the next sign
  var addrCache = {};
  var addrTimer = 0;
  var closeTimer = 0;
  var opener = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leaflet) return leaflet;
    leaflet = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET + 'leaflet.css';
      document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = LEAFLET + 'leaflet.js';
      js.onload = resolve;
      js.onerror = function () { leaflet = null; js.remove(); reject(new Error('leaflet')); };
      document.head.appendChild(js);
    });
    return leaflet;
  }

  function tileLayer(name) {
    var t = TILES[name];
    return window.L.tileLayer(t.url, { maxNativeZoom: t.native, maxZoom: 20, attribution: t.attribution });
  }

  function createMap() {
    var L = window.L;
    map = L.map('pinMapCanvas', { center: START.center, zoom: START.zoom, maxZoom: 20, zoomControl: false, tap: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    layers.map = tileLayer('map');
    layers.sat = tileLayer('sat');
    layers[layerName].addTo(map);
    map.on('movestart', function () { stage.classList.add('is-moving'); });
    map.on('moveend', function () { stage.classList.remove('is-moving'); updatePlace(); });
  }

  function setLayer(name) {
    if (!map || name === layerName) return;
    map.removeLayer(layers[layerName]);
    layerName = name;
    layers[name].addTo(map);
    $('pinLayer').setAttribute('aria-pressed', String(name === 'sat'));
  }

  function toast(text, busyIcon) {
    var el = $('pinToast');
    el.textContent = text || '';
    el.hidden = !text;
    el.classList.toggle('is-busy', !!busyIcon);
  }

  function showError(text) {
    var el = $('pinErr');
    el.textContent = text || '';
    el.hidden = !text;
  }

  function locate() {
    var m = msg();
    if (!navigator.geolocation) { toast(m.noGps); return; }
    toast(m.locating, true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      toast('');
      if (!map) return;
      var ll = [pos.coords.latitude, pos.coords.longitude];
      var L = window.L;
      if (me) map.removeLayer(me);
      me = L.layerGroup([
        L.circle(ll, { radius: Math.min(pos.coords.accuracy || 0, 500), color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }),
        L.circleMarker(ll, { radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false })
      ]).addTo(map);
      map.setView(ll, PIN_ZOOM, { animate: !reduceMotion });
    }, function (err) {
      toast(err && err.code === 1 ? m.gpsDenied : m.noGps);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
  }

  function addrKey(c) { return c.lat.toFixed(5) + ',' + c.lng.toFixed(5); }

  // Street address of a point, from OpenStreetMap's Nominatim (in Thai, for the sheet).
  function addressFor(c) {
    var key = addrKey(c);
    if (addrCache[key]) return addrCache[key];
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=th&lat=' +
      c.lat.toFixed(6) + '&lon=' + c.lng.toFixed(6);
    addrCache[key] = fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (j) { return (j && j.display_name) || ''; })
      .catch(function () { delete addrCache[key]; return ''; });
    return addrCache[key];
  }

  function updatePlace() {
    if (!map) return;
    var m = msg();
    var c = map.getCenter();
    $('pinCoord').textContent = coordText(c.lat, c.lng);
    var addr = $('pinAddr');
    clearTimeout(addrTimer);
    if (map.getZoom() < MIN_ZOOM) {
      addr.textContent = m.zoomIn;
      addr.className = 'is-hint';
      return;
    }
    showError('');
    addr.textContent = m.addrLoading;
    addr.className = 'is-loading';
    var key = addrKey(c);
    addrTimer = setTimeout(function () {
      addressFor(c).then(function (text) {
        if (!map || addrKey(map.getCenter()) !== key) return;
        addr.textContent = text || m.addrNone;
        addr.className = text ? '' : 'is-hint';
      });
    }, 600);
  }

  function openMap() {
    clearTimeout(closeTimer);
    if (!record) record = newRecord('manual');
    opener = document.activeElement;
    dialog.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { dialog.classList.add('is-open'); });
    $('pinNote').value = record.note;
    showError('');
    toast('');
    $('pinConfirm').disabled = false;
    dialog.querySelector('.pinmap__panel').focus({ preventScroll: true });

    loadLeaflet().then(function () {
      if (dialog.hidden) return;
      var fresh = !map;
      if (fresh) createMap();
      map.invalidateSize();
      setTimeout(function () { if (map) map.invalidateSize(); }, 420); // after the opening animation
      if (record.lat != null) {
        map.setView([record.lat, record.lng], PIN_ZOOM, { animate: false });
      } else {
        if (lastView) map.setView(lastView.center, lastView.zoom, { animate: false });
        else if (!fresh) map.setView(START.center, START.zoom, { animate: false });
        locate(); // usually done standing in front of the sign
      }
      updatePlace();
    }, function () {
      showError(msg().mapError);
    });
  }

  function closeMap() {
    if (dialog.hidden || !dialog.classList.contains('is-open')) return;
    dialog.classList.remove('is-open');
    document.body.style.overflow = '';
    clearTimeout(addrTimer);
    closeTimer = setTimeout(function () { dialog.hidden = true; }, reduceMotion ? 0 : 300);
    var back = opener && document.contains(opener) && opener !== document.body ? opener : $('pinBtn');
    back.focus({ preventScroll: true });
  }

  function confirmPin() {
    if (!map) return;
    var m = msg();
    if (map.getZoom() < MIN_ZOOM) {
      showError(m.zoomIn);
      dialog.querySelector('.pinmap__panel').classList.remove('is-shaking');
      void dialog.offsetWidth;
      dialog.querySelector('.pinmap__panel').classList.add('is-shaking');
      return;
    }
    var c = map.getCenter();
    var r = record;
    var button = $('pinConfirm');
    button.disabled = true;
    // Wait briefly for the address, but never hold the pin back for it.
    Promise.race([addressFor(c), new Promise(function (ok) { setTimeout(function () { ok(''); }, ADDRESS_WAIT); })])
      .then(function (address) {
        button.disabled = false;
        r.lat = round6(c.lat);
        r.lng = round6(c.lng);
        r.address = address || '';
        r.note = $('pinNote').value.replace(/\s+/g, ' ').trim().slice(0, 200);
        lastView = { center: [r.lat, r.lng], zoom: map.getZoom() };
        closeMap();
        render();
        save();
      });
  }

  /* ---------- Events ---------- */
  $('pinBtn').addEventListener('click', openMap);
  $('pinConfirm').addEventListener('click', confirmPin);
  $('pinLocate').addEventListener('click', function () { if (map) locate(); });
  $('pinLayer').addEventListener('click', function () { setLayer(layerName === 'map' ? 'sat' : 'map'); });
  dialog.addEventListener('click', function (e) {
    if (e.target.closest('[data-pin-close]')) closeMap();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !dialog.hidden && !root.classList.contains('auth-on')) closeMap();
  });

  // A new scan is a new sign: save it now (photo included), then ask where it is.
  document.addEventListener('scandone', function (e) {
    var d = e.detail || {};
    record = newRecord('scan', d.width, d.length, d.photo);
    render();
    save();
    openMap();
  });

  document.addEventListener('taxcalculated', function (e) {
    var d = e.detail;
    // A different size typed in is a different sign; the earlier one stays in the records.
    if (record && record.source === 'manual' && record.id && record.calc &&
        (record.calc.width !== d.width || record.calc.length !== d.length)) {
      record = null;
    }
    if (!record) record = newRecord('manual');
    record.calc = d;
    render();
    save();
  });

  $('calcForm').addEventListener('reset', function () {
    record = null;
    render();
  });

  document.addEventListener('langchange', function () {
    render();
    if (map && !dialog.hidden) updatePlace();
  });

  render();
})();
