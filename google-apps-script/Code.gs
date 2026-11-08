/**
 * Signage Tax customer API, run as a Google Apps Script web app.
 *
 * Paste this file into Extensions > Apps Script of the "SignageTax" spreadsheet,
 * then deploy it as a web app (see README.md). The website talks to it with:
 *   GET  ?action=districts                  -> registration office codes
 *   POST {action:'register', ...}           -> new row in the Customer sheet
 *   POST {action:'login', identifier, password}
 *   POST {action:'forgot', identifier}      -> the stored password
 *   POST {action:'profile', id, token}      -> the signed-in member's details
 *   POST {action:'updateProfile', id, token, districtCode, name, phone, email, address}
 *   POST {action:'changePassword', id, token, currentPassword, newPassword}
 *   POST {action:'saveBanner', id, token, bannerId?, width, length, signType, fontType,
 *         measuredBy, lat, lng, address, note, photo?} -> new or updated row in "banners"
 * Sign in returns a session token, kept in the Customer sheet, that the profile
 * actions must send back. Changing the password issues a new one.
 * POST bodies are sent as plain text JSON so the browser skips the CORS preflight.
 */

var DISTRICT_SHEET = 'District_code';
var DISTRICT_FIRST_ROW = 4;       // rows 1-3 are the title and the column headings
var CUSTOMER_SHEET = 'Customer';
var TIME_ZONE = 'Asia/Bangkok';
var HEADERS = ['Customer ID', 'Registered At', 'District Code', 'District Name', 'Name',
  'Phone', 'Email', 'Password', 'Address', 'Last Login', 'Session Token', 'Updated At'];
var COL = { id: 0, registered: 1, districtCode: 2, districtName: 3, name: 4,
  phone: 5, email: 6, password: 7, address: 8, lastLogin: 9, token: 10, updated: 11 };

// One row per banner a member scans or calculates, linked to them by Customer ID.
var BANNER_SHEET = 'banners';
var BANNER_HEADERS = ['Banner ID', 'Saved At', 'Updated At', 'Customer ID', 'Customer Name', 'Phone',
  'District Code', 'District Name', 'Width (cm)', 'Length (cm)', 'Area (sq cm)', 'Sign Type', 'Font Type',
  'Rate (baht / 500 sq cm)', 'Tax (baht / year)', 'Measured By', 'Latitude', 'Longitude', 'Google Maps',
  'Address', 'Note', 'Photo'];
var BCOL = { id: 0, saved: 1, updated: 2, customerId: 3, name: 4, phone: 5, districtCode: 6, districtName: 7,
  width: 8, length: 9, area: 10, signType: 11, fontType: 12, rate: 13, tax: 14, measuredBy: 15,
  lat: 16, lng: 17, maps: 18, address: 19, note: 20, photo: 21 };
var BANNER_NUMBERS = [BCOL.width, BCOL.length, BCOL.area, BCOL.rate, BCOL.tax]; // stored as numbers, so they add up
var PHOTO_FOLDER = 'Signage Tax banner photos';
var MAX_PHOTO_CHARS = 4000000; // about 3 MB of JPEG

// Baht per 500 sq cm, the same table as the website's calculator.
var RATES = {
  changeable: { type1: 10, type2: 52, type3: 52 },
  fixed: { type1: 5, type2: 26, type3: 50 }
};
var SIGN_TYPES = {
  changeable: 'ป้ายเคลื่อนที่/เปลี่ยนข้อความหรือภาพได้ (ก)',
  fixed: 'ป้ายเคลื่อนที่/เปลี่ยนข้อความหรือภาพไม่ได้ (ข)'
};
var FONT_TYPES = {
  type1: 'ประเภทที่ 1 อักษรไทยล้วน',
  type2: 'ประเภทที่ 2 อักษรไทยปน อักษรต่างประเทศ ภาพ หรือเครื่องหมายอื่น',
  type3: 'ประเภทที่ 3 ไม่มีอักษรไทย หรือมีอักษรไทยบางส่วน หรือทั้งหมดอยู่ต่ำกว่าอักษรต่างประเทศ'
};
var MEASURED_BY = { scan: 'Scan', scan_edited: 'Scan (edited)', manual: 'Typed in' };

function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : '';
  return respond(function () {
    if (action === 'districts') return { ok: true, districts: getDistricts() };
    return { ok: true, service: 'Signage Tax customer API' };
  });
}

function doPost(e) {
  return respond(function () {
    var body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      return fail('bad_request');
    }
    if (body.action === 'register') return register(body);
    if (body.action === 'login') return login(body);
    if (body.action === 'forgot') return forgot(body);
    if (body.action === 'profile') return profile(body);
    if (body.action === 'updateProfile') return updateProfile(body);
    if (body.action === 'changePassword') return changePassword(body);
    if (body.action === 'saveBanner') return saveBanner(body);
    if (body.action === 'districts') return { ok: true, districts: getDistricts() };
    return fail('bad_request');
  });
}

/** Run once from the editor to create the sheet headings and grant access (Sheets and Drive). */
function setup() {
  customerSheet();
  bannerSheet();
  photoFolder();
  Logger.log(getDistricts().length + ' district codes found.');
}

/* ---------- Actions ---------- */

/** Cleans and checks the details shared by registration and profile updates. */
function readDetails(body) {
  var data = {
    districtCode: clean(body.districtCode, 20),
    name: clean(body.name, 120),
    phone: normalizePhone(body.phone),
    email: clean(body.email, 160).toLowerCase(),
    address: clean(body.address, 400)
  };
  data.district = findDistrict(data.districtCode);
  data.invalid = [];
  if (!data.district) data.invalid.push('districtCode');
  if (data.name.length < 2) data.invalid.push('name');
  if (!isPhone(data.phone)) data.invalid.push('phone');
  if (!isEmail(data.email)) data.invalid.push('email');
  return data;
}

function isPassword(value) { return value.length >= 6 && value.length <= 64; }

/** Returns 'email_taken' or 'phone_taken' when another row already uses them. */
function duplicateOf(rows, data, skipIndex) {
  for (var i = 0; i < rows.length; i++) {
    if (i === skipIndex) continue;
    if (String(rows[i][COL.email]).toLowerCase() === data.email) return 'email_taken';
    if (normalizePhone(rows[i][COL.phone]) === data.phone) return 'phone_taken';
  }
  return '';
}

function register(body) {
  var data = readDetails(body);
  data.password = String(body.password || '');
  if (!isPassword(data.password)) data.invalid.push('password');
  if (data.invalid.length) return fail('invalid', { fields: data.invalid });
  var district = data.district;

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = customerSheet();
    var rows = customerRows(sheet);
    var taken = duplicateOf(rows, data, -1);
    if (taken) return fail(taken);

    var row = [];
    row[COL.id] = 'C' + ('00000' + (rows.length + 1)).slice(-6);
    row[COL.registered] = now();
    row[COL.districtCode] = district.code;
    row[COL.districtName] = district.name;
    row[COL.name] = data.name;
    row[COL.phone] = data.phone;
    row[COL.email] = data.email;
    row[COL.password] = data.password;
    row[COL.address] = data.address;
    row[COL.lastLogin] = '';
    row[COL.token] = '';
    row[COL.updated] = '';

    // Plain text keeps the phone's leading 0 and stops Sheets reading input as formulas.
    var target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length);
    target.setNumberFormat('@');
    target.setValues([row.map(asText)]);
    return { ok: true, customer: publicCustomer(row) };
  } finally {
    lock.releaseLock();
  }
}

function login(body) {
  var password = String(body.password || '');
  var match = findCustomer(body.identifier);
  if (!match || String(match.row[COL.password]) !== password) return fail('wrong_credentials');
  // One token per member, shared by their devices until the password changes.
  var token = String(match.row[COL.token] || '');
  if (!token) {
    token = Utilities.getUuid();
    setCell(match, COL.token, token);
  }
  setCell(match, COL.lastLogin, now());
  return { ok: true, customer: publicCustomer(match.row), token: token };
}

function profile(body) {
  var match = authorize(body);
  if (!match) return fail('session_expired');
  return { ok: true, customer: publicCustomer(match.row) };
}

function updateProfile(body) {
  var data = readDetails(body);
  if (data.invalid.length) return fail('invalid', { fields: data.invalid });
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var match = authorize(body);
    if (!match) return fail('session_expired');
    var taken = duplicateOf(match.rows, data, match.rowNumber - 2);
    if (taken) return fail(taken);
    setCell(match, COL.districtCode, data.district.code);
    setCell(match, COL.districtName, data.district.name);
    setCell(match, COL.name, data.name);
    setCell(match, COL.phone, data.phone);
    setCell(match, COL.email, data.email);
    setCell(match, COL.address, data.address);
    setCell(match, COL.updated, now());
    return { ok: true, customer: publicCustomer(match.row) };
  } finally {
    lock.releaseLock();
  }
}

function changePassword(body) {
  var current = String(body.currentPassword || '');
  var next = String(body.newPassword || '');
  var match = authorize(body);
  if (!match) return fail('session_expired');
  if (String(match.row[COL.password]) !== current) return fail('wrong_password');
  if (!isPassword(next)) return fail('invalid', { fields: ['newPassword'] });
  if (next === current) return fail('same_password');
  var token = Utilities.getUuid(); // signs out the member's other devices
  setCell(match, COL.password, next);
  setCell(match, COL.token, token);
  setCell(match, COL.updated, now());
  return { ok: true, token: token };
}

function forgot(body) {
  var match = findCustomer(body.identifier);
  if (!match) return fail('not_found');
  return { ok: true, password: String(match.row[COL.password]) };
}

/** Saves a banner: a new row, or an update to the member's own row when bannerId is given. */
function saveBanner(body) {
  var width = number(body.width, 1, 100000);
  var length = number(body.length, 1, 100000);
  var hasLat = body.lat !== '' && body.lat != null, hasLng = body.lng !== '' && body.lng != null;
  var lat = hasLat ? number(body.lat, -90, 90) : '';
  var lng = hasLng ? number(body.lng, -180, 180) : '';
  var invalid = [];
  if (width === null) invalid.push('width');
  if (length === null) invalid.push('length');
  if (lat === null || lng === null || hasLat !== hasLng) invalid.push('location');
  var photo = String(body.photo || '');
  if (photo && (photo.length > MAX_PHOTO_CHARS || !/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(photo))) invalid.push('photo');
  if (invalid.length) return fail('invalid', { fields: invalid });

  var signType = SIGN_TYPES[body.signType] ? String(body.signType) : '';
  var fontType = FONT_TYPES[body.fontType] ? String(body.fontType) : '';
  var rate = signType && fontType ? RATES[signType][fontType] : '';
  var area = Math.round(width * length * 100) / 100;
  var tax = rate === '' ? '' : Math.round(area * rate / 500 * 100) / 100;

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var member = authorize(body);
    if (!member) return fail('session_expired');
    var sheet = bannerSheet();
    var count = sheet.getLastRow() - 1;
    var rows = count > 0 ? sheet.getRange(2, 1, count, BANNER_HEADERS.length).getDisplayValues() : [];

    var rowNumber = 0, row;
    var bannerId = clean(body.bannerId, 20);
    if (bannerId) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i][BCOL.id] === bannerId) {
          // A member may only change their own banners.
          if (rows[i][BCOL.customerId] !== member.row[COL.id]) return fail('not_found');
          rowNumber = i + 2;
          row = rows[i];
          break;
        }
      }
      if (!rowNumber) return fail('not_found');
    } else {
      rowNumber = sheet.getLastRow() + 1;
      row = BANNER_HEADERS.map(function () { return ''; });
      // One more than the highest ID so far, so deleted rows never cause a repeat.
      var last = rows.reduce(function (max, r) { return Math.max(max, parseInt(String(r[BCOL.id]).slice(1), 10) || 0); }, 0);
      row[BCOL.id] = 'B' + ('00000' + (last + 1)).slice(-6);
      row[BCOL.saved] = now();
    }

    row[BCOL.updated] = bannerId ? now() : '';
    row[BCOL.customerId] = member.row[COL.id];
    row[BCOL.name] = member.row[COL.name];
    row[BCOL.phone] = normalizePhone(member.row[COL.phone]);
    row[BCOL.districtCode] = member.row[COL.districtCode];
    row[BCOL.districtName] = member.row[COL.districtName];
    row[BCOL.width] = width;
    row[BCOL.length] = length;
    row[BCOL.area] = area;
    // Keep an earlier calculation when this save only moves the pin.
    if (signType && fontType || !bannerId) {
      row[BCOL.signType] = signType ? SIGN_TYPES[signType] : '';
      row[BCOL.fontType] = fontType ? FONT_TYPES[fontType] : '';
      row[BCOL.rate] = rate;
      row[BCOL.tax] = tax;
    } else if (row[BCOL.rate] !== '') {
      row[BCOL.tax] = Math.round(area * toNumber(row[BCOL.rate]) / 500 * 100) / 100;
    }
    row[BCOL.measuredBy] = MEASURED_BY[body.measuredBy] || MEASURED_BY.manual;
    if (hasLat) {
      row[BCOL.lat] = lat.toFixed(6);
      row[BCOL.lng] = lng.toFixed(6);
      row[BCOL.maps] = 'https://www.google.com/maps?q=' + lat.toFixed(6) + ',' + lng.toFixed(6);
      row[BCOL.address] = clean(body.address, 300);
    }
    if (body.note != null) row[BCOL.note] = clean(body.note, 200);
    if (photo) {
      try {
        row[BCOL.photo] = savePhoto(photo, row[BCOL.id]);
      } catch (err) {
        console.error(err); // the record matters more than the photo
      }
    }

    var target = sheet.getRange(rowNumber, 1, 1, BANNER_HEADERS.length);
    var isNumber = function (v, i) { return BANNER_NUMBERS.indexOf(i) !== -1 && v !== ''; };
    target.setNumberFormats([row.map(function (v, i) { return isNumber(v, i) ? '#,##0.00' : '@'; })]);
    target.setValues([row.map(function (v, i) { return isNumber(v, i) ? toNumber(v) : asText(v); })]);
    return { ok: true, bannerId: row[BCOL.id], tax: row[BCOL.tax] === '' ? '' : toNumber(row[BCOL.tax]) };
  } finally {
    lock.releaseLock();
  }
}

/** Stores the scan photo in Drive (private to the sheet's owner) and returns its link. */
function savePhoto(dataUrl, bannerId) {
  var bytes = Utilities.base64Decode(dataUrl.slice(dataUrl.indexOf(',') + 1));
  var name = bannerId + ' ' + Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HHmmss') + '.jpg';
  return photoFolder().createFile(Utilities.newBlob(bytes, 'image/jpeg', name)).getUrl();
}

function photoFolder() {
  var found = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(PHOTO_FOLDER);
}

/** A number from a cell, which may show thousands separators. */
function toNumber(value) { return typeof value === 'number' ? value : Number(String(value).replace(/,/g, '')); }

/** A number within [min, max], or null. */
function number(value, min, max) {
  var n = typeof value === 'number' ? value : parseFloat(String(value == null ? '' : value).replace(/,/g, ''));
  return isFinite(n) && n >= min && n <= max ? n : null;
}

/* ---------- Sheets ---------- */

function getDistricts() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(DISTRICT_SHEET);
  if (!sheet) throw new Error('Sheet "' + DISTRICT_SHEET + '" not found');
  var count = sheet.getLastRow() - DISTRICT_FIRST_ROW + 1;
  if (count < 1) return [];
  return sheet.getRange(DISTRICT_FIRST_ROW, 2, count, 2).getDisplayValues()
    .map(function (r) { return [String(r[0]).trim(), String(r[1]).trim()]; })
    .filter(function (r) { return r[0] && r[1]; });
}

function findDistrict(code) {
  if (!code) return null;
  var list = getDistricts();
  for (var i = 0; i < list.length; i++) {
    if (list[i][0] === code) return { code: list[i][0], name: list[i][1] };
  }
  return null;
}

function customerSheet() { return sheetWithHeaders(CUSTOMER_SHEET, HEADERS); }
function bannerSheet() { return sheetWithHeaders(BANNER_SHEET, BANNER_HEADERS); }

function sheetWithHeaders(name, headers) {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(name) || book.insertSheet(name);
  var first = sheet.getRange(1, 1, 1, headers.length);
  var current = first.getValues()[0];
  // Writes any missing headings, including columns added after the sheet was made.
  var missing = headers.some(function (h, i) { return !String(current[i]).trim(); });
  if (missing) {
    first.setValues([headers]).setFontWeight('bold').setBackground('#0a2a5e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** The member whose id and session token match, or null. */
function authorize(body) {
  var id = clean(body.id, 20);
  var token = String(body.token || '');
  if (!id || !token) return null;
  var sheet = customerSheet();
  var rows = customerRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.id]) === id) {
      return String(rows[i][COL.token]) === token ? { sheet: sheet, row: rows[i], rowNumber: i + 2, rows: rows } : null;
    }
  }
  return null;
}

/** Writes one cell as plain text and keeps the in-memory row in step. */
function setCell(match, col, value) {
  match.sheet.getRange(match.rowNumber, col + 1).setNumberFormat('@').setValue(asText(value));
  match.row[col] = String(value);
}

function customerRows(sheet) {
  var count = sheet.getLastRow() - 1;
  return count > 0 ? sheet.getRange(2, 1, count, HEADERS.length).getDisplayValues() : [];
}

/** Finds a customer by email or phone number. */
function findCustomer(identifier) {
  var id = clean(identifier, 160);
  if (!id) return null;
  var isMail = id.indexOf('@') !== -1;
  var email = id.toLowerCase();
  var phone = normalizePhone(id);
  if (!isMail && !isPhone(phone)) return null;

  var sheet = customerSheet();
  var rows = customerRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    var hit = isMail
      ? String(rows[i][COL.email]).toLowerCase() === email
      : normalizePhone(rows[i][COL.phone]) === phone;
    if (hit) return { sheet: sheet, row: rows[i], rowNumber: i + 2 };
  }
  return null;
}

/* ---------- Helpers ---------- */

function publicCustomer(row) {
  return {
    id: row[COL.id], name: row[COL.name], phone: normalizePhone(row[COL.phone]), email: row[COL.email],
    districtCode: row[COL.districtCode], districtName: row[COL.districtName],
    address: row[COL.address] || '', registeredAt: row[COL.registered] || ''
  };
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Thai numbers: keeps digits and turns +66 / 66 into a leading 0. */
function normalizePhone(value) {
  var digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (digits.indexOf('66') === 0 && digits.length === 11) digits = '0' + digits.slice(2);
  if (digits.length === 9 && digits.charAt(0) !== '0') digits = '0' + digits; // leading 0 lost in Sheets
  return digits;
}

function isPhone(digits) { return /^0\d{8,9}$/.test(digits); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value); }

/** A leading apostrophe makes Sheets keep text such as "=1+1" as typed. */
function asText(value) {
  var text = String(value == null ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function now() { return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'); }

function fail(code, extra) {
  var out = { ok: false, code: code };
  if (extra) for (var k in extra) out[k] = extra[k];
  return out;
}

function respond(handler) {
  var result;
  try {
    result = handler();
  } catch (err) {
    console.error(err);
    result = fail('server');
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
