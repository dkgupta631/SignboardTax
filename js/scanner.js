// Measures a sign from a camera photo. The sign's outline is found automatically
// where possible, and can be corrected. One photo cannot give real size on its
// own, so the customer also marks an item of known size on the same surface. A perspective transform from that item gives the sign's size in cm,
// including for photos taken at an angle.
(function () {
  'use strict';

  // Real size in cm, short side then long side.
  var REFERENCES = { a4: [21, 29.7], card: [5.398, 8.56] };
  var SUCCESS_MS = 3200;
  var MAX_CM = 100000;
  var LIVE_MS = 250;
  var VOICE_TEXT = 'สแกนสำเร็จ'; // spoken in Thai in both page languages

  var $ = function (id) { return document.getElementById(id); };
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var box = $('scan');
  var video = $('scanVideo');
  var pic = $('scanPic');
  var liveOutline = $('scanLive');
  var text = $('scanText');
  var errorBox = $('scanError');
  var refType = $('scanRefType');
  var refW = $('scanRefW');
  var refH = $('scanRefH');

  var stream = null;
  var step = 'closed';
  var size = null; // photo size in pixels
  var photo = '';
  var signPts = [];
  var refPts = [];
  var closeTimer = 0;
  var liveTimer = 0;

  function msg() { return window.I18N_MESSAGES[document.documentElement.lang === 'en' ? 'en' : 'th']; }

  function setText(value, isError) {
    text.textContent = value;
    text.classList.toggle('is-error', !!isError);
  }

  /* ---------- Camera ---------- */
  function stopCamera() {
    clearTimeout(liveTimer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video.srcObject = null;
  }

  function startCamera() {
    errorBox.hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject({ name: 'Unavailable' });
    }
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      return video.play();
    });
  }

  function open() {
    startCamera().then(function () {
      box.hidden = false;
      document.body.style.overflow = 'hidden';
      setStep('live');
      $('scanClose').focus();
    }).catch(function (err) {
      stopCamera();
      errorBox.textContent = err && err.name === 'NotAllowedError' ? msg().scanDenied : msg().scanNoCamera;
      errorBox.hidden = false;
    });
  }

  // Keeps a glowing outline on the sign while the camera is running.
  function trackSign() {
    if (step !== 'live' || !stream) return;
    var w = video.videoWidth;
    var h = video.videoHeight;
    var found = window.detectSign(video, w, h);
    box.classList.toggle('is-locked', !!found);
    liveOutline.textContent = '';
    if (found) {
      liveOutline.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      liveOutline.appendChild(outline(found, 'scan__lock'));
    }
    liveTimer = setTimeout(trackSign, LIVE_MS);
  }

  function close() {
    clearTimeout(closeTimer);
    stopCamera();
    box.hidden = true;
    document.body.style.overflow = '';
    step = 'closed';
    $('scanBtn').focus();
  }

  function capture() {
    if (!video.videoWidth) return;
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    photo = canvas.toDataURL('image/jpeg', 0.9);
    size = { w: canvas.width, h: canvas.height };
    stopCamera();
    var found = window.detectSign(canvas, canvas.width, canvas.height);
    signPts = found || rect(0.15, 0.2, 0.85, 0.8);
    refPts = rect(0.42, 0.38, 0.58, 0.62);
    setStep('sign');
    if (found) setText(msg().scanSignFound);
  }

  function rect(x1, y1, x2, y2) {
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(function (p) {
      return [p[0] * size.w, p[1] * size.h];
    });
  }

  /* ---------- Steps ---------- */
  function setStep(next) {
    step = next;
    box.dataset.step = next;
    if (next === 'live') {
      setText(msg().scanLive);
      box.classList.remove('is-locked');
      liveOutline.textContent = '';
      trackSign();
    }
    if (next === 'sign') setText(msg().scanSign);
    if (next === 'ref') setText(msg().scanRef);
    if (next === 'sign' || next === 'ref') drawPhoto();
  }

  /* ---------- Marking corners ---------- */
  function node(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function outline(points, cls) {
    return node('polygon', {
      'class': cls,
      'vector-effect': 'non-scaling-stroke',
      points: points.map(function (p) { return p.join(','); }).join(' ')
    });
  }

  function drawPhoto() {
    pic.setAttribute('viewBox', '0 0 ' + size.w + ' ' + size.h);
    pic.textContent = '';
    pic.appendChild(node('image', { href: photo, width: size.w, height: size.h }));
    pic.appendChild(outline(signPts, 'scan__sign'));
    if (step === 'ref') pic.appendChild(outline(refPts, 'scan__ref'));
    var active = step === 'ref' ? refPts : signPts;
    var scale = size.w / (pic.getBoundingClientRect().width || size.w);
    var fit = Math.max(scale, size.h / (pic.getBoundingClientRect().height || size.h));
    active.forEach(function (p, i) {
      var handle = node('circle', {
        'class': 'scan__handle ' + (step === 'ref' ? 'scan__handle--ref' : ''),
        'vector-effect': 'non-scaling-stroke',
        cx: p[0], cy: p[1], r: 15 * fit, 'data-i': i
      });
      pic.appendChild(handle);
    });
  }

  function toPhoto(e) {
    var pt = pic.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    var p = pt.matrixTransform(pic.getScreenCTM().inverse());
    return [Math.min(size.w, Math.max(0, p.x)), Math.min(size.h, Math.max(0, p.y))];
  }

  var dragging = -1;
  pic.addEventListener('pointerdown', function (e) {
    if (!e.target.dataset || e.target.dataset.i === undefined) return;
    dragging = Number(e.target.dataset.i);
    pic.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  pic.addEventListener('pointermove', function (e) {
    if (dragging < 0) return;
    (step === 'ref' ? refPts : signPts)[dragging] = toPhoto(e);
    drawPhoto();
  });
  function endDrag() { dragging = -1; }
  pic.addEventListener('pointerup', endDrag);
  pic.addEventListener('pointercancel', endDrag);

  /* ---------- Measuring ---------- */
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  // Corners must run clockwise around a shape with no dents or crossings.
  function isConvex(q) {
    return q.every(function (p, i) {
      var a = q[(i + 1) % 4];
      var b = q[(i + 2) % 4];
      return (a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0]) > 0;
    });
  }

  function solve(m) {
    var n = m.length;
    for (var c = 0; c < n; c++) {
      var pivot = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
      var swap = m[c]; m[c] = m[pivot]; m[pivot] = swap;
      if (Math.abs(m[c][c]) < 1e-10) return null;
      for (var k = 0; k < n; k++) {
        if (k === c) continue;
        var f = m[k][c] / m[c][c];
        for (var j = c; j <= n; j++) m[k][j] -= f * m[c][j];
      }
    }
    return m.map(function (row, i) { return row[n] / row[i]; });
  }

  // Perspective transform taking four photo points to four real points.
  function homography(from, to) {
    var rows = [];
    from.forEach(function (p, i) {
      var x = p[0], y = p[1], u = to[i][0], v = to[i][1];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    });
    return solve(rows);
  }

  function referenceSize() {
    if (refType.value === 'custom') {
      var w = parseFloat(refW.value);
      var h = parseFloat(refH.value);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    // A4 and cards can be held either way round, so match what was marked.
    var known = REFERENCES[refType.value];
    var across = (dist(refPts[0], refPts[1]) + dist(refPts[3], refPts[2])) / 2;
    var down = (dist(refPts[0], refPts[3]) + dist(refPts[1], refPts[2])) / 2;
    return across > down ? [known[1], known[0]] : known;
  }

  // Returns { width, length } in cm, or null if the marks cannot be measured.
  function measure(ref) {
    if (!isConvex(signPts) || !isConvex(refPts)) return null;
    var h = homography(refPts, [[0, 0], [ref[0], 0], [ref[0], ref[1]], [0, ref[1]]]);
    if (!h) return null;
    var real = [];
    for (var i = 0; i < 4; i++) {
      var p = signPts[i];
      var d = h[6] * p[0] + h[7] * p[1] + 1;
      if (d <= 0) return null; // the point lies beyond the vanishing line
      real.push([(h[0] * p[0] + h[1] * p[1] + h[2]) / d, (h[3] * p[0] + h[4] * p[1] + h[5]) / d]);
    }
    var width = Math.round((dist(real[0], real[1]) + dist(real[3], real[2])) / 2);
    var length = Math.round((dist(real[0], real[3]) + dist(real[1], real[2])) / 2);
    return width >= 1 && length >= 1 && width <= MAX_CM && length <= MAX_CM ? { width: width, length: length } : null;
  }

  function fill(id, value) {
    var input = $(id);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------- Success ---------- */
  function chime(ctx) {
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
  }

  // Devices vary in speech quality and limit its volume, so a loudness-limited
  // recording plays instead. Built-in speech is only the fallback.
  function speak() {
    if (!window.speechSynthesis) return;
    var say = new SpeechSynthesisUtterance(VOICE_TEXT);
    say.lang = 'th-TH';
    say.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(say);
  }

  function dataToBuffer(url) {
    var bytes = atob(url.split(',')[1]);
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
    return out.buffer;
  }

  function announce() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { speak(); return; }
    var ctx = new Ctx();
    if (ctx.resume) ctx.resume();
    chime(ctx);
    ctx.decodeAudioData(dataToBuffer(window.SCAN_VOICE), function (buffer) {
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = function () { ctx.close(); };
      source.start(ctx.currentTime + 0.3);
    }, speak);
  }

  function finish() {
    var ref = referenceSize();
    if (!ref) { setText(msg().scanRefMissing, true); return; }
    var result = measure(ref);
    if (!result) { setText(msg().scanBadMarks, true); return; }
    fill('width', result.width);
    fill('length', result.length);
    $('scanResult').textContent = msg().scanResult(result.width.toLocaleString('en-US'), result.length.toLocaleString('en-US'));
    setStep('done');
    announce();
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    closeTimer = setTimeout(close, SUCCESS_MS);
  }

  /* ---------- Controls ---------- */
  $('scanBtn').addEventListener('click', open);
  $('scanClose').addEventListener('click', close);
  $('scanCapture').addEventListener('click', capture);
  $('scanRetake').addEventListener('click', function () {
    startCamera().then(function () { setStep('live'); }).catch(function () {
      close();
      errorBox.textContent = msg().scanNoCamera;
      errorBox.hidden = false;
    });
  });
  $('scanNext').addEventListener('click', function () { setStep('ref'); });
  $('scanBack').addEventListener('click', function () { setStep('sign'); });
  $('scanMeasure').addEventListener('click', finish);
  refType.addEventListener('change', function () {
    $('scanCustom').hidden = refType.value !== 'custom';
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && step !== 'closed') close();
  });
  window.addEventListener('resize', function () {
    if (step === 'sign' || step === 'ref') drawPhoto();
  });
})();
