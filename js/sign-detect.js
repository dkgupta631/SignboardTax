// Finds the outline of a sign, the way document scanner apps do: strong colour
// edges enclose regions, the region at the middle of the frame is filled in, and
// it counts only if it is close to a four-sided shape. Returns corners as top
// left, top right, bottom right, bottom left in source pixels, or null when
// nothing is convincing. Finding nothing is better than a wrong outline.
(function () {
  'use strict';

  var WORK_WIDTH = 320;
  var EDGE_SHARES = [0.2, 0.14, 0.09, 0.05]; // share of pixels treated as edges
  var OPEN_RADIUS = 4; // removes thin attachments such as wires and rooflines
  var MIN_AREA = 0.06;
  var MAX_AREA = 0.95;
  var MIN_FILL = 0.86; // how fully the region must fill its four-sided shape
  var MIN_FILL_COLOUR = 0.72; // lower, as a hand or logo may bite into a plain colour
  var COLOUR_RANGE = 26; // per-channel average difference from the sign's colour
  var MAX_TILT = 28; // degrees a side may lean from level or upright

  var canvas = document.createElement('canvas');
  var context = null;

  // Strongest colour change at each pixel, across the three channels.
  function gradients(data, w, h) {
    var mag = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var p = (y * w + x) * 4;
        var strongest = 0;
        for (var c = 0; c < 3; c++) {
          var gx = data[p + 4 + c] - data[p - 4 + c];
          var gy = data[p + w * 4 + c] - data[p - w * 4 + c];
          strongest = Math.max(strongest, Math.abs(gx) + Math.abs(gy));
        }
        mag[y * w + x] = strongest;
      }
    }
    return mag;
  }

  function limitFor(mag, share) {
    var sorted = Array.prototype.slice.call(mag.filter(function (v, i) { return i % 7 === 0; }));
    sorted.sort(function (a, b) { return b - a; });
    return Math.max(24, sorted[Math.floor(sorted.length * share)] || 0);
  }

  // Everything the frame's border cannot reach without crossing an edge.
  function enclosed(mag, limit, w, h) {
    var wall = new Uint8Array(w * h);
    var x, y, p;
    for (p = 0; p < w * h; p++) {
      if (mag[p] < limit) continue;
      x = p % w;
      y = (p - x) / w;
      wall[p] = 1;
      if (x > 0) wall[p - 1] = 1;
      if (x < w - 1) wall[p + 1] = 1;
      if (y > 0) wall[p - w] = 1;
      if (y < h - 1) wall[p + w] = 1;
    }
    var outside = new Uint8Array(w * h);
    var stack = [];
    function push(i) {
      if (!wall[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
    }
    for (x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      p = stack.pop();
      x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * (h - 1)) push(p + w);
    }
    var inside = new Uint8Array(w * h);
    for (p = 0; p < w * h; p++) inside[p] = outside[p] ? 0 : 1;
    return inside;
  }

  // Square filter over a summed table: keeps pixels whose square is all set
  // (erode) or sets pixels whose square has any set (dilate).
  function squareFilter(src, w, h, r, dilate) {
    var sum = new Int32Array((w + 1) * (h + 1));
    var x, y;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        sum[(y + 1) * (w + 1) + x + 1] = src[y * w + x] + sum[y * (w + 1) + x + 1] + sum[(y + 1) * (w + 1) + x] - sum[y * (w + 1) + x];
      }
    }
    var out = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        var count = sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
        out[y * w + x] = dilate ? (count > 0 ? 1 : 0) : (count === (x1 - x0) * (y1 - y0) ? 1 : 0);
      }
    }
    return out;
  }

  function regionAtCentre(mask, w, h) {
    var start = Math.floor(h / 2) * w + Math.floor(w / 2);
    if (!mask[start]) return null;
    var seen = new Uint8Array(w * h);
    var stack = [start];
    var pixels = [];
    seen[start] = 1;
    function push(i) {
      if (mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); }
    }
    while (stack.length) {
      var p = stack.pop();
      pixels.push(p);
      var x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * (h - 1)) push(p + w);
    }
    return pixels;
  }

  function quadArea(q) {
    var sum = 0;
    for (var i = 0; i < 4; i++) {
      var n = q[(i + 1) % 4];
      sum += q[i][0] * n[1] - n[0] * q[i][1];
    }
    return sum / 2;
  }

  function tilt(a, b, upright) {
    var dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    return Math.atan2(upright ? dx : dy, upright ? dy : dx) * 180 / Math.PI;
  }

  function candidate(pixels, w, h, minFill) {
    var tl = [0, 0], tr = [0, 0], br = [0, 0], bl = [0, 0];
    var minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
    pixels.forEach(function (p) {
      var x = p % w, y = (p - x) / w;
      if (x + y < minSum) { minSum = x + y; tl = [x, y]; }
      if (x + y > maxSum) { maxSum = x + y; br = [x, y]; }
      if (x - y > maxDiff) { maxDiff = x - y; tr = [x, y]; }
      if (x - y < minDiff) { minDiff = x - y; bl = [x, y]; }
    });
    var q = [tl, tr, br, bl];
    var area = quadArea(q);
    var size = area / (w * h);
    if (size < MIN_AREA || size > MAX_AREA) return null;
    var fill = pixels.length / area;
    if (fill < minFill) return null;
    if (tilt(tl, tr, false) > MAX_TILT || tilt(bl, br, false) > MAX_TILT) return null;
    if (tilt(tl, bl, true) > MAX_TILT || tilt(tr, br, true) > MAX_TILT) return null;
    return { q: q, score: Math.pow(Math.min(fill, 1), 4) * Math.pow(size, 0.25) };
  }

  // Pixels close to the colour at the middle of the frame, for plain signs whose
  // outline is broken by something in front of them.
  function sameColour(data, w, h) {
    var total = [0, 0, 0], count = 0, x, y, c;
    for (y = Math.floor(h / 2) - 2; y <= Math.floor(h / 2) + 2; y++) {
      for (x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 2; x++) {
        for (c = 0; c < 3; c++) total[c] += data[(y * w + x) * 4 + c];
        count++;
      }
    }
    var mask = new Uint8Array(w * h);
    for (var p = 0; p < w * h; p++) {
      var diff = 0;
      for (c = 0; c < 3; c++) diff += Math.abs(data[p * 4 + c] - total[c] / count);
      mask[p] = diff < COLOUR_RANGE * 3 ? 1 : 0;
    }
    return mask;
  }

  function find(data, w, h) {
    var mag = gradients(data, w, h);
    var top = null;
    EDGE_SHARES.forEach(function (share) {
      var inside = enclosed(mag, limitFor(mag, share), w, h);
      var opened = squareFilter(squareFilter(inside, w, h, OPEN_RADIUS, false), w, h, OPEN_RADIUS, true);
      var pixels = regionAtCentre(opened, w, h);
      var found = pixels && candidate(pixels, w, h, MIN_FILL);
      if (found && (!top || found.score > top.score)) top = found;
    });
    var plain = squareFilter(squareFilter(sameColour(data, w, h), w, h, OPEN_RADIUS, false), w, h, OPEN_RADIUS, true);
    var region = regionAtCentre(plain, w, h);
    var flat = region && candidate(region, w, h, MIN_FILL_COLOUR);
    if (flat && (!top || flat.score > top.score)) top = flat;
    return top && top.q;
  }

  window.detectSign = function (source, sourceW, sourceH) {
    if (!sourceW || !sourceH) return null;
    var w = Math.min(WORK_WIDTH, sourceW);
    var h = Math.round(sourceH * w / sourceW);
    canvas.width = w;
    canvas.height = h;
    context = context || canvas.getContext('2d', { willReadFrequently: true });
    context.filter = 'blur(1px)';
    context.drawImage(source, 0, 0, w, h);
    context.filter = 'none';
    var q = find(context.getImageData(0, 0, w, h).data, w, h);
    if (!q) return null;
    var k = sourceW / w;
    return q.map(function (p) { return [p[0] * k, p[1] * k]; });
  };
})();
