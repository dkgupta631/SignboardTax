// Measures a sign in real time with augmented reality (WebXR), the way Google's
// Measure app does. The phone tracks real distances in 3D, so the customer only
// aims the centre crosshair at the sign's four corners and taps + for each one;
// no reference item and no dragging. This needs Chrome on an Android phone that
// supports Google Play Services for AR, over https. Other devices get a message
// asking them to type the size.
(function () {
  'use strict';

  var CORNERS = 4;            // top left, top right, bottom right, bottom left
  var DONE_MS = 2600;
  var MAX_CM = 100000;

  var $ = function (id) { return document.getElementById(id); };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var root = $('arm');
  var svg = $('armSvg');
  var text = $('armText');
  var live = $('armLive');
  var reticle = $('armReticle');
  var addBtn = $('armAdd');
  var undoBtn = $('armUndo');
  var errorBox = $('scanError');

  var session = null;
  var gl = null;
  var refSpace = null;
  var hitSource = null;
  var view = null;       // latest camera view, for drawing points on screen
  var camera = null;     // latest camera position
  var aim = null;        // where the crosshair meets a real surface, or null
  var points = [];
  var finished = false;

  function msg() { return window.I18N_MESSAGES[document.documentElement.lang === 'en' ? 'en' : 'th']; }

  function showError(key) {
    errorBox.textContent = msg()[key];
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var width = $('width');
    if (width) width.focus({ preventScroll: true });
  }

  /* ---------- Geometry ---------- */
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  // World point to CSS pixels on the overlay, or null when behind the camera.
  function toScreen(p) {
    if (!view) return null;
    var m = view.transform.inverse.matrix;   // world to camera
    var P = view.projectionMatrix;           // camera to clip
    var c = [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      1
    ];
    var x = P[0] * c[0] + P[4] * c[1] + P[8] * c[2] + P[12] * c[3];
    var y = P[1] * c[0] + P[5] * c[1] + P[9] * c[2] + P[13] * c[3];
    var w = P[3] * c[0] + P[7] * c[1] + P[11] * c[2] + P[15] * c[3];
    if (w <= 0) return null;
    return [(x / w * 0.5 + 0.5) * window.innerWidth, (0.5 - y / w * 0.5) * window.innerHeight];
  }

  function cm(metres) { return Math.round(metres * 100); }

  /* ---------- Drawing ---------- */
  function node(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function draw() {
    svg.textContent = '';
    var path = points.slice();
    if (aim && points.length < CORNERS) path.push(aim);
    if (points.length === CORNERS) path.push(points[0]); // close the outline
    var screen = path.map(toScreen);
    for (var i = 1; i < screen.length; i++) {
      if (!screen[i - 1] || !screen[i]) continue;
      var pending = aim && i === points.length && points.length < CORNERS;
      svg.appendChild(node('line', {
        'class': 'arm__line' + (pending ? ' arm__line--live' : ''),
        x1: screen[i - 1][0], y1: screen[i - 1][1], x2: screen[i][0], y2: screen[i][1]
      }));
    }
    points.forEach(function (p) {
      var s = toScreen(p);
      if (s) svg.appendChild(node('circle', { 'class': 'arm__point', cx: s[0], cy: s[1], r: 9 }));
    });
  }

  function renderText() {
    var m = msg();
    if (finished) return;
    if (!aim) text.textContent = m.arFind;
    else text.textContent = m.arAim(m.arCorners[points.length], points.length + 1);
    var parts = [];
    if (aim && camera) parts.push(m.arDistance((dist(camera, aim)).toFixed(2)));
    if (aim && points.length && points.length < CORNERS) parts.push(m.arSide(cm(dist(points[points.length - 1], aim)).toLocaleString('en-US')));
    live.textContent = parts.join('  ·  ');
    live.hidden = !parts.length;
    reticle.classList.toggle('is-locked', !!aim);
    addBtn.disabled = !aim;
    undoBtn.disabled = !points.length;
    Array.prototype.forEach.call(root.querySelectorAll('.arm__step'), function (dot, i) {
      dot.classList.toggle('is-done', i < points.length);
      dot.classList.toggle('is-now', i === points.length);
    });
  }

  /* ---------- Session ---------- */
  function onFrame(time, frame) {
    if (!session) return;
    session.requestAnimationFrame(onFrame);
    var layer = session.renderState.baseLayer;
    // The camera picture is drawn by the browser; this layer stays transparent.
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var pose = frame.getViewerPose(refSpace);
    if (!pose) return;
    view = pose.views[0];
    var c = pose.transform.position;
    camera = [c.x, c.y, c.z];
    var hits = hitSource ? frame.getHitTestResults(hitSource) : [];
    var hitPose = hits.length ? hits[0].getPose(refSpace) : null;
    aim = hitPose ? [hitPose.transform.position.x, hitPose.transform.position.y, hitPose.transform.position.z] : null;
    draw();
    renderText();
  }

  function requestHits(viewerSpace) {
    // Feature points help at sign corners that stick out from the wall; not every phone offers them.
    return session.requestHitTestSource({ space: viewerSpace, entityTypes: ['plane', 'point'] })
      .catch(function () { return session.requestHitTestSource({ space: viewerSpace }); });
  }

  function start() {
    errorBox.hidden = true;
    if (session) return;
    if (!window.isSecureContext || !navigator.xr || !window.XRWebGLLayer) { showError('arUnsupported'); return; }
    navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
      if (!ok) { showError('arUnsupported'); return; }
      points = [];
      finished = false;
      aim = null;
      root.classList.remove('is-done');
      root.hidden = false;
      return navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test', 'dom-overlay'],
        domOverlay: { root: root }
      }).then(function (s) {
        session = s;
        session.addEventListener('end', onEnd);
        var canvas = document.createElement('canvas');
        gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
        return (gl.makeXRCompatible ? gl.makeXRCompatible() : Promise.resolve()).then(function () {
          session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
          return Promise.all([session.requestReferenceSpace('local'), session.requestReferenceSpace('viewer')]);
        }).then(function (spaces) {
          refSpace = spaces[0];
          return requestHits(spaces[1]);
        }).then(function (source) {
          hitSource = source;
          renderText();
          session.requestAnimationFrame(onFrame);
        });
      });
    }).catch(function () {
      root.hidden = true;
      if (session) session.end().catch(function () {});
      showError('arFailed');
    });
  }

  function stop() {
    if (session) session.end().catch(function () {});
  }

  function onEnd() {
    if (hitSource && hitSource.cancel) hitSource.cancel();
    session = null;
    hitSource = null;
    view = null;
    svg.textContent = '';
    root.hidden = true;
    root.classList.remove('is-done');
    var btn = $('scanBtn');
    if (btn && !finished) btn.focus({ preventScroll: true });
  }

  /* ---------- Corners ---------- */
  function fill(id, value) {
    var input = $(id);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Short chime plus the recorded "scan complete" clip from js/scan-voice.js.
  function announce() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !window.SCAN_VOICE) return;
    var ctx = new Ctx();
    [880, 1320].forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      var at = ctx.currentTime + i * 0.13;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.5, at);
      gain.gain.exponentialRampToValueAtTime(0.01, at + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.13);
    });
    var bytes = atob(window.SCAN_VOICE.split(',')[1]);
    var buf = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    ctx.decodeAudioData(buf.buffer, function (audio) {
      var src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(ctx.destination);
      src.onended = function () { ctx.close(); };
      src.start(ctx.currentTime + 0.3);
    }, function () {});
  }

  function finish() {
    var p = points;
    var width = cm((dist(p[0], p[1]) + dist(p[3], p[2])) / 2);
    var length = cm((dist(p[0], p[3]) + dist(p[1], p[2])) / 2);
    if (!(width >= 1 && length >= 1 && width <= MAX_CM && length <= MAX_CM)) {
      points = [];
      text.textContent = msg().arRetry;
      return;
    }
    finished = true;
    fill('width', width);
    fill('length', length);
    $('armResult').textContent = msg().scanResult(width.toLocaleString('en-US'), length.toLocaleString('en-US'));
    root.classList.add('is-done');
    announce();
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    setTimeout(stop, DONE_MS);
  }

  addBtn.addEventListener('click', function () {
    if (!aim || finished || points.length >= CORNERS) return;
    points.push(aim.slice());
    if (navigator.vibrate) navigator.vibrate(20);
    if (points.length === CORNERS) finish();
    renderText();
  });
  undoBtn.addEventListener('click', function () {
    if (finished) return;
    points.pop();
    renderText();
  });
  $('armClose').addEventListener('click', stop);
  document.addEventListener('langchange', function () { if (session) renderText(); });

  $('scanBtn').addEventListener('click', start);
  // The middle tab: move to the form the results fill in, and measure straight away.
  $('tabScan').addEventListener('click', function () {
    location.hash = '#/calc';
    start();
  });
})();
