// Turns marked photo corners into a sign's real width and length.
//
// The sign is a rectangle, so its four corners alone fix its shape (width to
// length) even in a photo taken at an angle: the way its sides converge gives
// the perspective, using the method of Zhang and He (2007) for photographed
// rectangles. The item of known size on the sign (A4 paper, a card) then only
// supplies the scale. This keeps small errors in marking that item from being
// stretched across the whole sign, which is what happens when the perspective
// is worked out from the small item alone.
(function (root) {
  'use strict';

  var FALLBACK_FOCAL = 0.8;      // typical phone camera, as a share of the longer image side
  var MIN_CONVERGENCE = 0.02;    // below this the sides look parallel and the focal length is guessed
  var MAX_CM = 100000;

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // Corners must run clockwise around a shape with no dents or crossings.
  function isConvex(q) {
    return q.length === 4 && q.every(function (p, i) {
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
      if (Math.abs(m[c][c]) < 1e-12) return null;
      for (var k = 0; k < n; k++) {
        if (k === c) continue;
        var f = m[k][c] / m[c][c];
        for (var j = c; j <= n; j++) m[k][j] -= f * m[c][j];
      }
    }
    return m.map(function (row, i) { return row[n] / row[i]; });
  }

  // Perspective transform taking four points to four other points.
  function homography(from, to) {
    var rows = [];
    from.forEach(function (p, i) {
      var x = p[0], y = p[1], u = to[i][0], v = to[i][1];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    });
    return solve(rows);
  }

  function apply(h, p) {
    var d = h[6] * p[0] + h[7] * p[1] + 1;
    if (d <= 0) return null; // the point lies beyond the vanishing line
    return [(h[0] * p[0] + h[1] * p[1] + h[2]) / d, (h[3] * p[0] + h[4] * p[1] + h[5]) / d];
  }

  // The sign's width divided by its length, from its corners (top left, top right,
  // bottom right, bottom left), in coordinates centred on the photo.
  function aspectRatio(q) {
    var m1 = [q[0][0], q[0][1], 1], m2 = [q[1][0], q[1][1], 1];
    var m4 = [q[2][0], q[2][1], 1], m3 = [q[3][0], q[3][1], 1];
    var c14 = cross(m1, m4);
    var k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
    var k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
    var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    // The focal length can be read from the photo only when both pairs of sides converge.
    var f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    var converge = Math.min(Math.abs(n2[2]) / Math.hypot(n2[0], n2[1]), Math.abs(n3[2]) / Math.hypot(n3[0], n3[1]));
    if (!(f2 > 0.09 && f2 < 16 && converge > MIN_CONVERGENCE)) f2 = FALLBACK_FOCAL * FALLBACK_FOCAL;
    var ratio = Math.sqrt((n2[0] * n2[0] + n2[1] * n2[1] + f2 * n2[2] * n2[2]) /
                          (n3[0] * n3[0] + n3[1] * n3[1] + f2 * n3[2] * n3[2]));
    return isFinite(ratio) && ratio > 0 ? ratio : null;
  }

  // sign, ref: corners in photo pixels, clockwise from top left.
  // refSize: the reference item's two sides in cm, in either order.
  // Returns { width, length, mismatch } in cm, or null when the marks cannot be
  // measured. mismatch is how far the reference's marked shape is from its real
  // shape (0.1 = 10%); a large value means the corners were probably misplaced.
  function measure(sign, ref, refSize, imageW, imageH) {
    if (!isConvex(sign) || !isConvex(ref)) return null;
    var cx = imageW / 2, cy = imageH / 2, scale = Math.max(imageW, imageH);
    var norm = function (p) { return [(p[0] - cx) / scale, (p[1] - cy) / scale]; };
    var s = sign.map(norm);
    var ratio = aspectRatio(s);
    if (!ratio) return null;

    // Straighten the sign into a ratio x 1 rectangle and see how big the reference is there.
    var h = homography(s, [[0, 0], [ratio, 0], [ratio, 1], [0, 1]]);
    if (!h) return null;
    var r = [];
    for (var i = 0; i < 4; i++) {
      var p = apply(h, norm(ref[i]));
      if (!p) return null;
      r.push(p);
    }
    var across = (dist(r[0], r[1]) + dist(r[3], r[2])) / 2;
    var down = (dist(r[0], r[3]) + dist(r[1], r[2])) / 2;
    if (!(across > 0 && down > 0)) return null;
    // The item may lie either way round; match its longer side to the longer marked side.
    var small = Math.min(refSize[0], refSize[1]), big = Math.max(refSize[0], refSize[1]);
    var realAcross = across >= down ? big : small;
    var realDown = across >= down ? small : big;
    var cmPerUnit = (realAcross + realDown) / (across + down);
    var mismatch = Math.abs(realAcross / across - realDown / down) / cmPerUnit;

    var width = ratio * cmPerUnit;
    var length = cmPerUnit;
    if (!(width >= 1 && length >= 1 && width <= MAX_CM && length <= MAX_CM)) return null;
    return { width: width, length: length, mismatch: mismatch };
  }

  // A function that takes a photo point to the sign's straightened plane, where
  // the sign is ratio x 1 (length = 1). Used to recognise the A4 sheet by its shape.
  function rectifier(sign, imageW, imageH) {
    if (!isConvex(sign)) return null;
    var cx = imageW / 2, cy = imageH / 2, scale = Math.max(imageW, imageH);
    var norm = function (p) { return [(p[0] - cx) / scale, (p[1] - cy) / scale]; };
    var s = sign.map(norm);
    var ratio = aspectRatio(s);
    if (!ratio) return null;
    var h = homography(s, [[0, 0], [ratio, 0], [ratio, 1], [0, 1]]);
    if (!h) return null;
    return function (p) { return apply(h, norm(p)); };
  }

  var api = { measure: measure, rectifier: rectifier, isConvex: isConvex, homography: homography };
  root.ScanMeasure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
