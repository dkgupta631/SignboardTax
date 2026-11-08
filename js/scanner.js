// Measures a sign from a camera photo. The sign's outline is found automatically
// where possible, snapped onto its real edges, and can be corrected with a
// magnifier. One photo cannot give real size on its own, so the customer also
// marks an item of known size stuck on the sign. js/scan-measure.js turns the
// marks into centimetres: the sign's own corners give the perspective and the
// item gives the scale, which stays accurate for photos taken at an angle.
(function () {
  'use strict';

  // Real size in cm, short side then long side.
  var REFERENCES = { a4: [21, 29.7], card: [5.398, 8.56] };
  var SUCCESS_MS = 2600;
  var LIVE_MS = 250;
  var SNAP_SHIFT = 12;       // after a drag, corners may move this far onto a clear edge
  var CHECK_MISMATCH = 0.15; // reference shape off by more than this: ask to check the marks
  var LOUPE_ZOOM = 4;
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
  var photoCanvas = null;
  var signPts = [];
  var refPts = [];
  var confirmedMarks = ''; // marks the customer chose to measure despite the warning
  var signFound = false;
  var paperFound = false;
  var paperMoved = false;   // the customer placed the green points themselves
  var closeTimer = 0;
  var scanned = null;       // a finished measurement, handed on when the scanner closes
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
      errorBox.scrollIntoView({ block: 'center' });
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
    // Also when the success screen is closed early: js/banner-map.js saves the
    // sign and asks for its location next.
    if (scanned) {
      var detail = scanned;
      scanned = null;
      document.dispatchEvent(new CustomEvent('scandone', { detail: detail }));
    }
  }

  function capture() {
    if (!video.videoWidth) return;
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    photo = canvas.toDataURL('image/jpeg', 0.9);
    photoCanvas = canvas;
    size = { w: canvas.width, h: canvas.height };
    stopCamera();
    var found = window.detectSign(canvas, canvas.width, canvas.height);
    // The rough outline comes from a small copy of the photo; move it onto the real edges.
    if (found) found = window.refineSign(canvas, canvas.width, canvas.height, found);
    signFound = !!found;
    signPts = found || rect(0.15, 0.2, 0.85, 0.8);
    confirmedMarks = '';
    paperMoved = false;
    findPaper();
    setStep('sign');
  }

  // Finds the A4 sheet on the sign, so usually nothing needs dragging. Without it,
  // a small green box waits in the middle of the sign to be moved onto the paper.
  function findPaper() {
    var toSign = window.ScanMeasure.rectifier(signPts, size.w, size.h);
    var paper = toSign && window.detectPaper(photoCanvas, size.w, size.h, signPts, toSign);
    paperFound = !!paper;
    refPts = paper || paperBox();
  }

  function paperBox() {
    var cx = 0, cy = 0;
    signPts.forEach(function (p) { cx += p[0] / 4; cy += p[1] / 4; });
    var across = Math.hypot(signPts[1][0] - signPts[0][0], signPts[1][1] - signPts[0][1]);
    var half = Math.max(24, across * 0.06);
    return [[cx - half, cy - half * 1.41], [cx + half, cy - half * 1.41], [cx + half, cy + half * 1.41], [cx - half, cy + half * 1.41]];
  }

  function markText() {
    if (!signFound) return msg().scanSign;
    return paperFound ? msg().scanBothFound : msg().scanPaperMissing;
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
    if (next === 'sign') {
      setText(markText());
      drawPhoto();
    }
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
    pic.appendChild(outline(refPts, 'scan__ref'));
    var scale = size.w / (pic.getBoundingClientRect().width || size.w);
    var fit = Math.max(scale, size.h / (pic.getBoundingClientRect().height || size.h));
    // Paper handles are smaller and drawn last, so they stay on top inside the sign.
    [['sign', signPts, 18], ['ref', refPts, 12]].forEach(function (set) {
      set[1].forEach(function (p, i) {
        pic.appendChild(node('circle', {
          'class': 'scan__handle' + (set[0] === 'ref' ? ' scan__handle--ref' : ''),
          'vector-effect': 'non-scaling-stroke',
          cx: p[0], cy: p[1], r: set[2] * fit, 'data-i': i, 'data-set': set[0]
        }));
        pic.appendChild(node('circle', { 'class': 'scan__dot', cx: p[0], cy: p[1], r: 2.5 * fit }));
      });
    });
  }

  /* ---------- Magnifier ---------- */
  // A finger hides the corner it drags, so a zoomed view shows where the point is.
  var loupe = document.createElement('canvas');
  loupe.className = 'scan__loupe';
  loupe.hidden = true;
  loupe.setAttribute('aria-hidden', 'true');
  pic.parentNode.appendChild(loupe);

  function drawLoupe(p, clientX) {
    var stage = pic.parentNode.getBoundingClientRect();
    var view = pic.getBoundingClientRect();
    var shown = Math.min(view.width / size.w, view.height / size.h); // screen px per photo px
    var css = Math.round(Math.min(150, stage.width * 0.36));
    var dpr = window.devicePixelRatio || 1;
    loupe.style.width = loupe.style.height = css + 'px';
    loupe.width = loupe.height = Math.round(css * dpr);
    // Keep the magnifier away from the finger.
    loupe.classList.toggle('is-right', clientX - stage.left < stage.width / 2);
    var ctx = loupe.getContext('2d');
    var k = (LOUPE_ZOOM * shown) * dpr; // canvas px per photo px
    var half = loupe.width / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#10272b';
    ctx.fillRect(0, 0, loupe.width, loupe.height);
    ctx.imageSmoothingEnabled = k < 3;
    ctx.setTransform(k, 0, 0, k, half - p[0] * k, half - p[1] * k);
    ctx.drawImage(photoCanvas, 0, 0);
    var pts = dragSet === 'ref' ? refPts : signPts;
    ctx.beginPath();
    pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
    ctx.lineWidth = 1.5 * dpr / k;
    ctx.strokeStyle = dragSet === 'ref' ? '#5fe0bd' : '#f28c38';
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(half, half - 14 * dpr); ctx.lineTo(half, half - 4 * dpr);
    ctx.moveTo(half, half + 4 * dpr); ctx.lineTo(half, half + 14 * dpr);
    ctx.moveTo(half - 14 * dpr, half); ctx.lineTo(half - 4 * dpr, half);
    ctx.moveTo(half + 4 * dpr, half); ctx.lineTo(half + 14 * dpr, half);
    ctx.stroke();
    loupe.hidden = false;
  }

  function toPhoto(e) {
    var pt = pic.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    var p = pt.matrixTransform(pic.getScreenCTM().inverse());
    return [Math.min(size.w, Math.max(0, p.x)), Math.min(size.h, Math.max(0, p.y))];
  }

  var dragging = -1;
  var dragSet = 'sign';
  pic.addEventListener('pointerdown', function (e) {
    if (!e.target.dataset || e.target.dataset.i === undefined) return;
    dragging = Number(e.target.dataset.i);
    dragSet = e.target.dataset.set === 'ref' ? 'ref' : 'sign';
    pic.setPointerCapture(e.pointerId);
    e.preventDefault();
    drawLoupe((dragSet === 'ref' ? refPts : signPts)[dragging], e.clientX);
  });
  pic.addEventListener('pointermove', function (e) {
    if (dragging < 0) return;
    var p = toPhoto(e);
    (dragSet === 'ref' ? refPts : signPts)[dragging] = p;
    drawPhoto();
    drawLoupe(p, e.clientX);
  });
  function endDrag() {
    if (dragging < 0) return;
    dragging = -1;
    loupe.hidden = true;
    // Small corrections onto a clear edge only; a deliberate mark further away stays.
    var pts = dragSet === 'ref' ? refPts : signPts;
    var snapped = window.refineSign(photoCanvas, size.w, size.h, pts, { search: 20, maxShift: SNAP_SHIFT });
    if (snapped !== pts && window.ScanMeasure.isConvex(snapped)) {
      if (dragSet === 'ref') refPts = snapped; else signPts = snapped;
    }
    if (dragSet === 'ref') paperMoved = true;
    else {
      signFound = true;
      // A corrected sign outline may reveal the paper that was missed before.
      if (!paperFound && !paperMoved) findPaper();
    }
    setText(markText());
    drawPhoto();
  }
  pic.addEventListener('pointerup', endDrag);
  pic.addEventListener('pointercancel', endDrag);

  /* ---------- Measuring ---------- */
  function referenceSize() {
    if (refType.value === 'custom') {
      var w = parseFloat(refW.value);
      var h = parseFloat(refH.value);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    return REFERENCES[refType.value];
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
    // Without the paper there is nothing to give real size; never guess.
    if (!paperFound && !paperMoved) { setText(msg().scanPaperMissing, true); return; }
    var ref = referenceSize();
    if (!ref) { setText(msg().scanRefMissing, true); return; }
    var result = window.ScanMeasure.measure(signPts, refPts, ref, size.w, size.h);
    if (!result) { setText(msg().scanBadMarks, true); return; }
    // A reference whose marked shape is clearly off usually means a misplaced corner.
    var marks = JSON.stringify([signPts, refPts, ref]);
    if (result.mismatch > CHECK_MISMATCH && confirmedMarks !== marks) {
      confirmedMarks = marks;
      setText(msg().scanCheckRef, true);
      return;
    }
    var width = Math.round(result.width);
    var length = Math.round(result.length);
    fill('width', width);
    fill('length', length);
    $('scanResult').textContent = msg().scanResult(width.toLocaleString('en-US'), length.toLocaleString('en-US'));
    setStep('done');
    announce();
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    scanned = { width: width, length: length, photo: smallPhoto() };
    closeTimer = setTimeout(close, SUCCESS_MS);
  }

  // A copy of the photo small enough to send with the record (longest side 1280 px).
  function smallPhoto() {
    if (!photoCanvas) return '';
    try {
      var k = Math.min(1, 1280 / Math.max(photoCanvas.width, photoCanvas.height));
      var c = document.createElement('canvas');
      c.width = Math.round(photoCanvas.width * k);
      c.height = Math.round(photoCanvas.height * k);
      c.getContext('2d').drawImage(photoCanvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return '';
    }
  }

  /* ---------- Controls ---------- */
  $('scanBtn').addEventListener('click', open);
  // The middle tab: move to the form the results fill in, and scan straight away.
  $('tabScan').addEventListener('click', function () {
    location.hash = '#/calc';
    open();
  });
  $('scanClose').addEventListener('click', close);
  $('scanCapture').addEventListener('click', capture);
  $('scanRetake').addEventListener('click', function () {
    startCamera().then(function () { setStep('live'); }).catch(function () {
      close();
      errorBox.textContent = msg().scanNoCamera;
      errorBox.hidden = false;
    });
  });
  $('scanNext').addEventListener('click', finish);
  refType.addEventListener('change', function () {
    $('scanCustom').hidden = refType.value !== 'custom';
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && step !== 'closed') close();
  });
  window.addEventListener('resize', function () {
    if (step === 'sign') drawPhoto();
  });
})();
