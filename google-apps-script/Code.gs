/**
 * Signage Tax customer API, run as a Google Apps Script web app.
 *
 * Paste this file into Extensions > Apps Script of the "SignageTax" spreadsheet,
 * then deploy it as a web app (see README.md). The website talks to it with:
 *   GET  ?action=districts                  -> registration office codes
 *   POST {action:'register', ...}           -> new row in the Customer sheet
 *   POST {action:'login', identifier, password}
 *   POST {action:'forgot', identifier}      -> the stored password
 * POST bodies are sent as plain text JSON so the browser skips the CORS preflight.
 */

var DISTRICT_SHEET = 'District_code';
var DISTRICT_FIRST_ROW = 4;       // rows 1-3 are the title and the column headings
var CUSTOMER_SHEET = 'Customer';
var TIME_ZONE = 'Asia/Bangkok';
var HEADERS = ['Customer ID', 'Registered At', 'District Code', 'District Name', 'Name',
  'Phone', 'Email', 'Password', 'Address', 'Last Login'];
var COL = { id: 0, registered: 1, districtCode: 2, districtName: 3, name: 4,
  phone: 5, email: 6, password: 7, address: 8, lastLogin: 9 };

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
    if (body.action === 'districts') return { ok: true, districts: getDistricts() };
    return fail('bad_request');
  });
}

/** Run once from the editor to create the Customer headings and grant access. */
function setup() {
  customerSheet();
  Logger.log(getDistricts().length + ' district codes found.');
}

/* ---------- Actions ---------- */

function register(body) {
  var data = {
    districtCode: clean(body.districtCode, 20),
    name: clean(body.name, 120),
    phone: normalizePhone(body.phone),
    email: clean(body.email, 160).toLowerCase(),
    password: String(body.password || ''),
    address: clean(body.address, 400)
  };

  var invalid = [];
  var district = findDistrict(data.districtCode);
  if (!district) invalid.push('districtCode');
  if (data.name.length < 2) invalid.push('name');
  if (!isPhone(data.phone)) invalid.push('phone');
  if (!isEmail(data.email)) invalid.push('email');
  if (data.password.length < 6 || data.password.length > 64) invalid.push('password');
  if (invalid.length) return fail('invalid', { fields: invalid });

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = customerSheet();
    var rows = customerRows(sheet);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][COL.email]).toLowerCase() === data.email) return fail('email_taken');
      if (normalizePhone(rows[i][COL.phone]) === data.phone) return fail('phone_taken');
    }

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
  match.sheet.getRange(match.rowNumber, COL.lastLogin + 1).setNumberFormat('@').setValue(now());
  return { ok: true, customer: publicCustomer(match.row) };
}

function forgot(body) {
  var match = findCustomer(body.identifier);
  if (!match) return fail('not_found');
  return { ok: true, password: String(match.row[COL.password]) };
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

function customerSheet() {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(CUSTOMER_SHEET) || book.insertSheet(CUSTOMER_SHEET);
  var first = sheet.getRange(1, 1, 1, HEADERS.length);
  if (!String(first.getValues()[0][0]).trim()) {
    first.setValues([HEADERS]).setFontWeight('bold').setBackground('#0a2a5e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
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
    id: row[COL.id], name: row[COL.name], phone: row[COL.phone], email: row[COL.email],
    districtCode: row[COL.districtCode], districtName: row[COL.districtName]
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
