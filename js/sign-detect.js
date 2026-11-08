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

  /* ---------- Refinement at full resolution ---------- */
  // The outline above comes from a small copy of the photo, so its corners can be
  // a dozen pixels out. Each side is moved onto the strongest colour edge near it
  // in the full photo, a straight line is fitted through those edge points, and
  // the corners become the crossings of neighbouring lines.
  var SEARCH = 26;        // pixels either side of the rough side to look for the edge
  var SAMPLES = 48;       // edge points per side
  var MAX_SHIFT = 45;     // a refined corner further than this is not trusted

  var full = document.createElement('canvas');
  var fullContext = null;

  function lineThrough(points) {
    var n = points.length, mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0, i;
    for (i = 0; i < n; i++) { mx += points[i][0]; my += points[i][1]; }
    mx /= n; my /= n;
    for (i = 0; i < n; i++) {
      var dx = points[i][0] - mx, dy = points[i][1] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    var angle = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the best-fit line
    return { x: mx, y: my, dx: Math.cos(angle), dy: Math.sin(angle) };
  }

  function offLine(line, p) { return Math.abs((p[0] - line.x) * line.dy - (p[1] - line.y) * line.dx); }

  function crossing(a, b) {
    var det = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(det) < 1e-6) return null;
    var t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / det;
    return [a.x + t * a.dx, a.y + t * a.dy];
  }

  function refine(data, w, h, quad, search, maxShift) {
    function colour(x, y, out) {
      var xi = Math.max(0, Math.min(w - 1, Math.round(x)));
      var yi = Math.max(0, Math.min(h - 1, Math.round(y)));
      var p = (yi * w + xi) * 4;
      out[0] = data[p]; out[1] = data[p + 1]; out[2] = data[p + 2];
    }
    var a = [0, 0, 0], b = [0, 0, 0];
    var lines = [];
    for (var side = 0; side < 4; side++) {
      var p0 = quad[side], p1 = quad[(side + 1) % 4];
      var len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (len < 20) return null;
      var ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
      var nx = -uy, ny = ux; // normal to the side
      var found = [];
      for (var k = 0; k < SAMPLES; k++) {
        var f = 0.1 + 0.8 * k / (SAMPLES - 1); // keep clear of the rounded corners
        var cx = p0[0] + (p1[0] - p0[0]) * f, cy = p0[1] + (p1[1] - p0[1]) * f;
        var best = 0, bestT = 0, strength = [];
        for (var t = -search; t <= search; t++) {
          colour(cx + nx * (t - 1.5), cy + ny * (t - 1.5), a);
          colour(cx + nx * (t + 1.5), cy + ny * (t + 1.5), b);
          var g = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          strength.push(g);
          if (g > best) { best = g; bestT = t; }
        }
        if (best < 45) continue; // no clear edge here (something in front, or a soft edge)
        var i0 = bestT + search;
        var l = strength[i0 - 1], r = strength[i0 + 1];
        var sub = (l !== undefined && r !== undefined && l + r - 2 * best !== 0) ? 0.5 * (l - r) / (l + r - 2 * best) : 0;
        var tt = bestT + Math.max(-0.5, Math.min(0.5, sub));
        found.push([cx + nx * tt, cy + ny * tt]);
      }
      if (found.length < SAMPLES * 0.4) return null;
      // Fit, drop points that disagree (text, a hand, a pole), fit again.
      var line = lineThrough(found);
      for (var pass = 0; pass < 2; pass++) {
        var dists = found.map(function (p) { return offLine(line, p); }).sort(function (x, y) { return x - y; });
        var limit = Math.max(1.5, dists[Math.floor(dists.length / 2)] * 2.5);
        var kept = found.filter(function (p) { return offLine(line, p) <= limit; });
        if (kept.length < SAMPLES * 0.3) return null;
        found = kept;
        line = lineThrough(found);
      }
      lines.push(line);
    }
    var corners = [];
    for (var c = 0; c < 4; c++) {
      var at = crossing(lines[(c + 3) % 4], lines[c]); // side before the corner meets side after it
      if (!at || Math.hypot(at[0] - quad[c][0], at[1] - quad[c][1]) > maxShift) return null;
      corners.push(at);
    }
    return corners;
  }

  var cache = { source: null, data: null };

  // Moves an outline onto the real edges of a sign or paper in the full-size photo.
  // options.search: how far from each side to look (pixels); options.maxShift: the
  // furthest a corner may move. Returns the original outline when the edges are not
  // clear enough, so a doubtful snap never replaces the customer's own marks.
  window.refineSign = function (source, sourceW, sourceH, quad, options) {
    if (!quad || !sourceW || !sourceH) return quad;
    options = options || {};
    if (cache.source !== source || !cache.data || full.width !== sourceW || full.height !== sourceH) {
      full.width = sourceW;
      full.height = sourceH;
      fullContext = fullContext || full.getContext('2d', { willReadFrequently: true });
      fullContext.drawImage(source, 0, 0, sourceW, sourceH);
      cache = { source: source, data: fullContext.getImageData(0, 0, sourceW, sourceH).data };
    }
    var shortest = Math.min.apply(null, quad.map(function (p, i) {
      var n = quad[(i + 1) % 4];
      return Math.hypot(n[0] - p[0], n[1] - p[1]);
    }));
    // Never search further than a third of the shortest side, or a small paper could
    // snap to its own opposite edge.
    var search = Math.max(4, Math.min(options.search || SEARCH, Math.floor(shortest / 3)));
    return refine(cache.data, sourceW, sourceH, quad, search, options.maxShift || MAX_SHIFT) || quad;
  };

  /* ---------- A4 sheet on the sign ---------- */
  // Looks inside the sign's outline for a plain white patch shaped like A4 paper
  // (1 : 1.414 once the sign's perspective is taken out), then snaps it onto the
  // paper's edges. Returns its corners in source pixels, or null.
  var PAPER_WIDTH = 960;
  var A4_RATIO = 29.7 / 21;
  var paperCanvas = document.createElement('canvas');
  var paperContext = null;

  window.detectPaper = function (source, sourceW, sourceH, sign, toSign) {
    if (!sign || !toSign || !sourceW || !sourceH) return null;
    var w = Math.min(PAPER_WIDTH, sourceW);
    var h = Math.round(sourceH * w / sourceW);
    var k = sourceW / w;
    paperCanvas.width = w;
    paperCanvas.height = h;
    paperContext = paperContext || paperCanvas.getContext('2d', { willReadFrequently: true });
    paperContext.drawImage(source, 0, 0, w, h);
    var data = paperContext.getImageData(0, 0, w, h).data;

    // Pixels inside the sign, a little in from its edges.
    var poly = sign.map(function (p) { return [p[0] / k, p[1] / k]; });
    var minX = w, minY = h, maxX = 0, maxY = 0;
    poly.forEach(function (p) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    });
    minX = Math.max(1, Math.floor(minX)); minY = Math.max(1, Math.floor(minY));
    maxX = Math.min(w - 2, Math.ceil(maxX)); maxY = Math.min(h - 2, Math.ceil(maxY));
    var edges = poly.map(function (p, i) {
      var n = poly[(i + 1) % 4], len = Math.hypot(n[0] - p[0], n[1] - p[1]) || 1;
      return { x: p[0], y: p[1], dx: (n[0] - p[0]) / len, dy: (n[1] - p[1]) / len };
    });
    function inside(x, y) {
      for (var i = 0; i < 4; i++) {
        var e = edges[i];
        if ((x - e.x) * e.dy - (y - e.y) * e.dx > -2) return false; // clockwise corners: inside is negative
      }
      return true;
    }

    var bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < 10 || bh < 10) return null;
    var inSign = new Uint8Array(bw * bh);
    var lum = new Float32Array(bw * bh);
    var sat = new Uint8Array(bw * bh);
    var lums = [];
    for (var y = 0; y < bh; y++) {
      for (var x = 0; x < bw; x++) {
        var px = x + minX, py = y + minY;
        if (!inside(px, py)) continue;
        var q = (py * w + px) * 4;
        var r = data[q], g = data[q + 1], b = data[q + 2];
        var i2 = y * bw + x;
        inSign[i2] = 1;
        lum[i2] = 0.299 * r + 0.587 * g + 0.114 * b;
        sat[i2] = Math.max(r, g, b) - Math.min(r, g, b);
        if ((x + y) % 3 === 0) lums.push(lum[i2]);
      }
    }
    if (lums.length < 50) return null;
    lums.sort(function (a, b2) { return a - b2; });
    var median = lums[Math.floor(lums.length / 2)];
    // Paper: clearly brighter than the sign around it, and nearly colourless.
    var limit = Math.max(140, Math.min(235, median + 40));
    var mask = new Uint8Array(bw * bh);
    for (var m = 0; m < mask.length; m++) mask[m] = inSign[m] && lum[m] >= limit && sat[m] <= 48 ? 1 : 0;

    var seen = new Uint8Array(bw * bh);
    var signArea = lums.length * 3;
    var best = null;
    for (var start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      var stack = [start], pixels = [];
      seen[start] = 1;
      while (stack.length) {
        var c = stack.pop();
        pixels.push(c);
        var cx = c % bw;
        [cx > 0 ? c - 1 : -1, cx < bw - 1 ? c + 1 : -1, c >= bw ? c - bw : -1, c < bw * (bh - 1) ? c + bw : -1].forEach(function (n) {
          if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        });
      }
      if (pixels.length < 120 || pixels.length > signArea * 0.4) continue;
      var tl, tr, br, bl, sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
      pixels.forEach(function (pp) {
        var xx = pp % bw + minX, yy = (pp - pp % bw) / bw + minY;
        if (xx + yy < sMin) { sMin = xx + yy; tl = [xx, yy]; }
        if (xx + yy > sMax) { sMax = xx + yy; br = [xx, yy]; }
        if (xx - yy > dMax) { dMax = xx - yy; tr = [xx, yy]; }
        if (xx - yy < dMin) { dMin = xx - yy; bl = [xx, yy]; }
      });
      var quad = [tl, tr, br, bl];
      var area = quadArea(quad);
      if (area <= 0) continue;
      var fill = pixels.length / area;
      if (fill < 0.7) continue;
      // Shape on the straightened sign: A4 is 1 : 1.414 whichever way it lies.
      var flat = quad.map(function (p) { return toSign([p[0] * k, p[1] * k]); });
      if (flat.some(function (p) { return !p; })) continue;
      var dist2 = function (a, b2) { return Math.hypot(a[0] - b2[0], a[1] - b2[1]); };
      var across = (dist2(flat[0], flat[1]) + dist2(flat[3], flat[2])) / 2;
      var down = (dist2(flat[0], flat[3]) + dist2(flat[1], flat[2])) / 2;
      var ratio = Math.max(across, down) / Math.min(across, down);
      var off = Math.abs(ratio / A4_RATIO - 1);
      if (off > 0.2) continue;
      var score = fill * (1 - off) * Math.sqrt(pixels.length);
      if (!best || score > best.score) best = { score: score, quad: quad };
    }
    if (!best) return null;
    var corners = best.quad.map(function (p) { return [(p[0] + 0.5) * k, (p[1] + 0.5) * k]; });
    return window.refineSign(source, sourceW, sourceH, corners, { search: 10, maxShift: 14 });
  };

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
