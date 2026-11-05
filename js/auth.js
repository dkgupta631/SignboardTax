// Member sign in, registration and password lookup, backed by a Google Sheet
// through the Apps Script web app in google-apps-script/Code.gs. The header's
// Sign in button opens the screen as an overlay (html.auth-on); the site itself
// stays open to everyone.
(function () {
  'use strict';

  var SESSION_KEY = 'signage-tax-session';
  var DISTRICT_KEY = 'signage-tax-districts';
  var DISTRICT_TTL = 24 * 60 * 60 * 1000;
  var MAX_SHOWN = 60;
  var TIMEOUT = 20000;

  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };
  var all = function (sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };
  var config = window.SIGNAGE_AUTH_CONFIG || {};
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia && matchMedia('(pointer: fine)').matches;

  function msg() { return window.I18N_MESSAGES[root.lang === 'en' ? 'en' : 'th'].auth; }
  function text(key) { var m = msg(); return m[key] || m.server; }

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable */ }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- Validation, matching Code.gs ---------- */
  function normalizePhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.indexOf('66') === 0 && digits.length === 11) digits = '0' + digits.slice(2);
    return digits;
  }
  function isPhone(digits) { return /^0\d{8,9}$/.test(digits); }
  function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value); }
  function isIdentifier(value) {
    value = value.trim();
    return value.indexOf('@') !== -1 ? isEmail(value) : isPhone(normalizePhone(value));
  }
  // Shown in international form: 0812345678 -> +66 81 234 5678, 021234567 -> +66 2 123 4567.
  function formatPhone(digits) {
    if (digits.length === 10 && digits.charAt(0) === '0') return '+66 ' + digits.slice(1, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6);
    if (digits.length === 9 && digits.charAt(0) === '0') return '+66 ' + digits.slice(1, 2) + ' ' + digits.slice(2, 5) + ' ' + digits.slice(5);
    return digits;
  }

  /* ---------- Google Apps Script API ---------- */
  function failure(code, data) {
    var e = new Error(code);
    e.code = code;
    e.fields = data && data.fields;
    return e;
  }

  function api(action, payload) {
    if (!config.scriptUrl) return Promise.reject(failure('not_configured'));
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    var url = config.scriptUrl;
    var options = { redirect: 'follow', signal: ctrl ? ctrl.signal : undefined };
    if (action === 'districts') {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'action=districts';
    } else {
      // text/plain keeps this a simple request, which Apps Script accepts cross-origin.
      options.method = 'POST';
      options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      options.body = JSON.stringify(Object.assign({ action: action }, payload));
    }
    return fetch(url, options)
      .then(function (res) {
        if (!res.ok) throw failure('server');
        return res.json().catch(function () { throw failure('server'); });
      }, function () { throw failure('network'); })
      .then(function (data) {
        if (!data || !data.ok) throw failure((data && data.code) || 'server', data);
        return data;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ---------- Views ---------- */
  var card = $('authCard');
  var views = { login: $('loginForm'), register: $('registerForm'), forgot: $('forgotForm') };
  var order = ['forgot', 'login', 'register'];
  var tabs = { login: $('tabLogin'), register: $('tabRegister') };
  var current = 'login';

  function firstInput(form) { return form.querySelector('input:not([type=hidden]), textarea'); }

  function showView(name, focusEl) {
    if (!views[name]) return;
    if (name !== current) {
      var back = order.indexOf(name) < order.indexOf(current);
      views[current].hidden = true;
      current = name;
      card.dataset.view = name;
      var to = views[name];
      to.hidden = false;
      to.classList.remove('is-in', 'is-back');
      void to.offsetWidth; // restart the entrance animation
      to.classList.add('is-in');
      to.classList.toggle('is-back', back);
      Object.keys(tabs).forEach(function (k) {
        var on = k === (name === 'register' ? 'register' : 'login');
        tabs[k].setAttribute('aria-selected', String(on));
        tabs[k].tabIndex = on ? 0 : -1;
      });
      if (name === 'register') loadDistricts();
    }
    var target = focusEl || firstInput(views[name]);
    if (target && (finePointer || focusEl)) target.focus({ preventScroll: true });
  }

  card.addEventListener('click', function (e) {
    var go = e.target.closest('[data-view-go]');
    if (go) showView(go.dataset.viewGo);
  });

  $('tabLogin').parentNode.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var next = current === 'register' ? 'login' : 'register';
    showView(next, tabs[next]);
  });

  /* ---------- Fields and alerts ---------- */
  all('.afield').forEach(function (field, i) {
    var err = field.querySelector('.afield__err');
    var input = field.querySelector('input, textarea');
    err.id = 'afield-err-' + i;
    input.setAttribute('aria-describedby', err.id + (field.querySelector('.afield__hint') ? ' ' + field.querySelector('.afield__hint').id : ''));
    input.addEventListener('input', function () { setError(input, ''); });
  });

  function renderField(field) {
    var key = field.dataset.err || '';
    var input = field.querySelector('input, textarea');
    field.classList.toggle('is-invalid', !!key);
    field.querySelector('.afield__err').textContent = key ? text(key) : '';
    if (key) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function setError(input, key) {
    var field = input.closest('.afield');
    if ((field.dataset.err || '') === key) return;
    field.dataset.err = key;
    renderField(field);
  }

  var ALERT_ICON = { error: 'i-warn', success: 'i-shield', info: 'i-lock' };
  function renderAlert(box) {
    var key = box.dataset.key;
    box.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><use href="#' + ALERT_ICON[box.dataset.type] + '"/></svg><span></span>';
    box.lastChild.textContent = text(key);
  }

  function showAlert(form, type, key) {
    var box = form.querySelector('.auth__alert');
    box.dataset.type = type;
    box.dataset.key = key;
    box.hidden = false;
    renderAlert(box);
    box.classList.remove('is-shown');
    void box.offsetWidth;
    box.classList.add('is-shown');
  }

  function clearAlert(form) {
    var box = form.querySelector('.auth__alert');
    box.hidden = true;
    box.dataset.key = '';
  }

  function shake(form) {
    if (reduceMotion) return;
    card.classList.remove('is-shaking');
    void card.offsetWidth;
    card.classList.add('is-shaking');
  }
  card.addEventListener('animationend', function (e) {
    if (e.animationName === 'authShake') card.classList.remove('is-shaking');
  });

  // Marks every invalid field, focuses the first one and reports whether all passed.
  function check(form, rules) {
    var firstBad = null;
    rules.forEach(function (r) {
      setError(r[0], r[1]);
      if (r[1] && !firstBad) firstBad = r[0];
    });
    if (firstBad) {
      shake(form);
      firstBad.focus();
      return false;
    }
    return true;
  }

  function setBusy(form, busy) {
    form.classList.toggle('is-busy', busy);
    form.setAttribute('aria-busy', String(busy));
    all('button, input, textarea', form).forEach(function (el) { el.disabled = busy; });
  }

  function handleFailure(form, err) {
    var fieldsByName = { districtCode: $('regDistrict'), name: $('regName'), phone: $('regPhone'), email: $('regEmail'), password: $('regPass') };
    var keys = { districtCode: 'district', name: 'name', phone: 'phone', email: 'email', password: 'password' };
    if (err.code === 'email_taken') setError($('regEmail'), 'email_taken');
    if (err.code === 'phone_taken') setError($('regPhone'), 'phone_taken');
    (err.fields || []).forEach(function (f) { if (fieldsByName[f]) setError(fieldsByName[f], keys[f]); });
    showAlert(form, 'error', msg()[err.code] ? err.code : 'server');
    shake(form);
  }

  // Password visibility toggles.
  card.addEventListener('click', function (e) {
    var eye = e.target.closest('.afield__eye');
    if (!eye) return;
    var input = eye.parentNode.querySelector('input');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    renderEye(eye);
  });
  function renderEye(eye) {
    var shown = eye.getAttribute('aria-pressed') === 'true';
    eye.setAttribute('aria-label', shown ? msg().hidePass : msg().showPass);
    eye.querySelector('use').setAttribute('href', shown ? '#i-eye-off' : '#i-eye');
  }
  function hidePasswords(form) {
    all('.afield__eye', form).forEach(function (eye) {
      eye.parentNode.querySelector('input').type = 'password';
      eye.setAttribute('aria-pressed', 'false');
      renderEye(eye);
    });
  }

  /* ---------- Login ---------- */
  var loginForm = views.login;
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = $('loginId');
    var pass = $('loginPass');
    clearAlert(loginForm);
    var ok = check(loginForm, [
      [id, !id.value.trim() ? 'required' : isIdentifier(id.value) ? '' : 'identifier'],
      [pass, pass.value ? '' : 'required']
    ]);
    if (!ok) return;
    setBusy(loginForm, true);
    api('login', { identifier: id.value.trim(), password: pass.value })
      .then(function (data) { signIn(data.customer); })
      .catch(function (err) {
        handleFailure(loginForm, err);
        if (err.code === 'wrong_credentials') { pass.value = ''; }
      })
      .finally(function () {
        setBusy(loginForm, false);
        if (loginForm.querySelector('.auth__alert').dataset.key === 'wrong_credentials') pass.focus();
      });
  });

  /* ---------- Registration ---------- */
  var regForm = views.register;
  var regPass = $('regPass');
  var meter = $('passMeter');

  function strength(p) {
    if (!p) return 0;
    if (p.length < 6) return 1;
    var score = 1;
    if (p.length >= 10) score++;
    if ((/[a-z]/i.test(p) && /\d/.test(p)) || /[^a-z0-9]/i.test(p)) score++;
    return score;
  }
  function renderMeter() {
    var level = strength(regPass.value);
    meter.dataset.level = level;
    meter.querySelector('em').textContent = msg().strength[level];
  }
  regPass.addEventListener('input', renderMeter);

  regForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearAlert(regForm);
    var name = $('regName'), phone = $('regPhone'), email = $('regEmail'), address = $('regAddress');
    var phoneDigits = normalizePhone(phone.value);
    var ok = check(regForm, [
      [districtInput, selected ? '' : 'district'],
      [name, name.value.trim().length >= 2 ? '' : name.value.trim() ? 'name' : 'required'],
      [phone, !phone.value.trim() ? 'required' : isPhone(phoneDigits) ? '' : 'phone'],
      [email, !email.value.trim() ? 'required' : isEmail(email.value.trim()) ? '' : 'email'],
      [regPass, !regPass.value ? 'required' : regPass.value.length >= 6 && regPass.value.length <= 64 ? '' : 'password']
    ]);
    if (!ok) { showAlert(regForm, 'error', 'fixFields'); return; }

    setBusy(regForm, true);
    api('register', {
      districtCode: selected[0],
      name: name.value.trim(),
      phone: phoneDigits,
      email: email.value.trim().toLowerCase(),
      password: regPass.value,
      address: address.value.trim()
    })
      .then(function (data) {
        var emailValue = data.customer.email;
        resetRegister();
        showView('login', $('loginPass'));
        $('loginId').value = emailValue;
        $('loginPass').value = '';
        showAlert(loginForm, 'success', 'registered');
      })
      .catch(function (err) { handleFailure(regForm, err); })
      .finally(function () { setBusy(regForm, false); });
  });

  function resetRegister() {
    regForm.reset();
    selectDistrict(null);
    clearAlert(regForm);
    all('.afield', regForm).forEach(function (f) { f.dataset.err = ''; renderField(f); });
    hidePasswords(regForm);
    renderMeter();
  }

  /* ---------- District search ---------- */
  var combo = $('districtCombo');
  var districtInput = $('regDistrict');
  var pop = combo.querySelector('.combo__pop');
  var list = $('districtList');
  var countEl = combo.querySelector('.combo__count');
  var statusEl = $('districtStatus');
  var districts = null;      // [code, name, lowercase "code · name"]
  var districtState = 'idle';
  var districtError = '';
  var selected = null;
  var matches = [];
  var active = -1;
  var wantOpen = false;     // the user asked for the list before it had loaded

  function labelOf(d) { return d[0] + ' · ' + d[1]; }

  function setDistricts(rows) {
    districts = rows.map(function (r) { return [String(r[0]), String(r[1]), (r[0] + ' · ' + r[1]).toLowerCase()]; });
    districtState = 'ready';
    renderStatus();
    if (wantOpen && document.activeElement === districtInput) openList();
    wantOpen = false;
  }

  function loadDistricts(force) {
    if (districtState === 'loading' || (districtState === 'ready' && !force)) return;
    var cached = read(DISTRICT_KEY);
    var usable = cached && Array.isArray(cached.list) && cached.list.length;
    if (usable && !force && Date.now() - cached.t < DISTRICT_TTL) { setDistricts(cached.list); return; }
    districtState = 'loading';
    renderStatus();
    api('districts')
      .then(function (data) {
        write(DISTRICT_KEY, { t: Date.now(), list: data.districts });
        setDistricts(data.districts);
      })
      .catch(function (err) {
        if (usable) { setDistricts(cached.list); return; } // an old list beats none
        districtState = 'failed';
        districtError = err.code;
        renderStatus();
      });
  }

  function renderStatus() {
    var m = msg();
    statusEl.classList.toggle('is-error', districtState === 'failed');
    if (districtState === 'loading') {
      statusEl.innerHTML = '<span class="mini-spin" aria-hidden="true"></span>' + escapeHtml(m.districtsLoading);
    } else if (districtState === 'ready') {
      statusEl.textContent = m.districtsReady(districts.length);
    } else if (districtState === 'failed') {
      statusEl.innerHTML = escapeHtml(districtError === 'not_configured' ? m.not_configured : m.districtsFailed) +
        (districtError === 'not_configured' ? '' : ' <button type="button" class="auth__link" id="districtRetry">' + escapeHtml(m.retry) + '</button>');
    } else {
      statusEl.textContent = '';
    }
  }
  statusEl.addEventListener('click', function (e) {
    if (e.target.id === 'districtRetry') { districtState = 'idle'; loadDistricts(true); }
  });

  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) return districts;
    var starts = [];
    var contains = [];
    districts.forEach(function (d) {
      if (d[0].indexOf(q) === 0) starts.push(d);
      else if (d[2].indexOf(q) !== -1) contains.push(d);
    });
    return starts.concat(contains);
  }

  function mark(value, q) {
    var i = q ? value.toLowerCase().indexOf(q) : -1;
    if (i === -1) return escapeHtml(value);
    return escapeHtml(value.slice(0, i)) + '<mark>' + escapeHtml(value.slice(i, i + q.length)) + '</mark>' + escapeHtml(value.slice(i + q.length));
  }

  function renderList() {
    var q = districtInput.value.trim().toLowerCase();
    if (selected && districtInput.value === labelOf(selected)) q = '';
    matches = search(q);
    var shown = matches.slice(0, MAX_SHOWN);
    list.innerHTML = shown.length ? shown.map(function (d, i) {
      var isSel = selected && selected[0] === d[0];
      return '<li class="combo__opt" role="option" id="dopt-' + i + '" data-i="' + i + '" aria-selected="' + isSel + '">' +
        '<b>' + mark(d[0], q) + '</b><span>' + mark(d[1], q) + '</span>' +
        (isSel ? '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-shield"/></svg>' : '') + '</li>';
    }).join('') : '<li class="combo__empty">' + escapeHtml(msg().noMatch) + '</li>';
    countEl.textContent = matches.length ? msg().matches(matches.length, shown.length) : '';
    var selIndex = selected ? shown.indexOf(selected) : -1;
    setActive(shown.length ? Math.max(selIndex, 0) : -1);
    list.scrollTop = 0;
    if (selIndex > 0) scrollActive();
  }

  function setActive(i) {
    var prev = list.querySelector('.is-active');
    if (prev) prev.classList.remove('is-active');
    active = i;
    var el = i >= 0 ? $('dopt-' + i) : null;
    if (el) {
      el.classList.add('is-active');
      districtInput.setAttribute('aria-activedescendant', el.id);
    } else {
      districtInput.removeAttribute('aria-activedescendant');
    }
  }
  function scrollActive() {
    var el = $('dopt-' + active);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function isOpen() { return !pop.hidden; }
  function openList() {
    if (districtState !== 'ready') { wantOpen = true; loadDistricts(); return; }
    renderList();
    if (isOpen()) return;
    pop.hidden = false;
    combo.classList.add('is-open');
    districtInput.setAttribute('aria-expanded', 'true');
  }
  function closeList() {
    if (!isOpen()) return;
    pop.hidden = true;
    combo.classList.remove('is-open');
    districtInput.setAttribute('aria-expanded', 'false');
    districtInput.removeAttribute('aria-activedescendant');
  }

  function selectDistrict(d) {
    selected = d;
    combo.classList.toggle('is-selected', !!d);
    districtInput.value = d ? labelOf(d) : '';
    if (d) setError(districtInput, '');
  }

  districtInput.addEventListener('click', openList);
  districtInput.addEventListener('input', function () {
    if (selected) { selected = null; combo.classList.remove('is-selected'); }
    if (isOpen()) renderList(); else openList();
  });
  districtInput.addEventListener('keydown', function (e) {
    var count = Math.min(matches.length, MAX_SHOWN);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) { openList(); return; }
      if (!count) return;
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
      scrollActive();
    } else if (e.key === 'Enter' && isOpen()) {
      e.preventDefault();
      if (active >= 0 && matches[active]) { selectDistrict(matches[active]); closeList(); }
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      closeList();
    }
  });
  districtInput.addEventListener('blur', function () {
    setTimeout(function () {
      if (combo.contains(document.activeElement)) return;
      closeList();
      if (!selected && districts) {
        // A typed code that exactly matches counts as a choice.
        var typed = districtInput.value.trim();
        for (var i = 0; i < districts.length; i++) {
          if (districts[i][0] === typed) { selectDistrict(districts[i]); break; }
        }
      }
    }, 120);
  });
  list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the input
  list.addEventListener('click', function (e) {
    var opt = e.target.closest('.combo__opt');
    if (!opt) return;
    selectDistrict(matches[+opt.dataset.i]);
    closeList();
  });
  list.addEventListener('mousemove', function (e) {
    var opt = e.target.closest('.combo__opt');
    if (opt && +opt.dataset.i !== active) setActive(+opt.dataset.i);
  });
  combo.querySelector('.combo__toggle').addEventListener('click', function () {
    if (isOpen()) closeList();
    else { districtInput.focus(); openList(); }
  });

  /* ---------- Forgot password ---------- */
  var forgotForm = views.forgot;
  var forgotId = $('forgotId');
  var forgotResult = $('forgotResult');
  var forgotSubmit = $('forgotSubmit');
  var forgotToLogin = $('forgotToLogin');
  var copyBtn = $('forgotCopy');
  var copyTimer = 0;

  function resetForgotResult() {
    forgotResult.hidden = true;
    $('forgotPass').textContent = '';
    forgotSubmit.hidden = false;
    forgotToLogin.hidden = true;
  }

  forgotForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearAlert(forgotForm);
    resetForgotResult();
    var ok = check(forgotForm, [[forgotId, !forgotId.value.trim() ? 'required' : isIdentifier(forgotId.value) ? '' : 'identifier']]);
    if (!ok) return;
    setBusy(forgotForm, true);
    api('forgot', { identifier: forgotId.value.trim() })
      .then(function (data) {
        $('forgotPass').textContent = data.password;
        forgotResult.hidden = false;
        forgotSubmit.hidden = true;
        forgotToLogin.hidden = false;
        showAlert(forgotForm, 'success', 'found');
      })
      .catch(function (err) { handleFailure(forgotForm, err); })
      .finally(function () { setBusy(forgotForm, false); });
  });
  forgotId.addEventListener('input', function () {
    if (!forgotResult.hidden) { resetForgotResult(); clearAlert(forgotForm); }
  });

  forgotToLogin.addEventListener('click', function () {
    var id = forgotId.value.trim();
    forgotForm.reset();
    resetForgotResult();
    clearAlert(forgotForm);
    clearAlert(loginForm);
    $('loginId').value = id;
    showView('login', $('loginPass'));
  });

  copyBtn.addEventListener('click', function () {
    var value = $('forgotPass').textContent;
    var done = function () {
      var note = copyBtn.querySelector('.secret__copied');
      copyBtn.classList.add('is-copied');
      note.textContent = msg().copied;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(function () {
        copyBtn.classList.remove('is-copied');
        note.textContent = '';
      }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(value).then(done, function () {});
    else {
      var range = document.createRange();
      range.selectNodeContents($('forgotPass'));
      var sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { document.execCommand('copy'); done(); } catch (err) { /* left selected for manual copy */ }
    }
  });

  /* ---------- Session ---------- */
  var authEl = $('auth');
  var signinBtn = $('signinBtn');
  var userBox = $('user');
  var userBtn = $('userBtn');
  var userPop = $('userPop');

  function session() {
    var s = read(SESSION_KEY);
    return s && s.customer && s.customer.email ? s : null;
  }

  function initialOf(name) {
    var chars = Array.from(String(name || '?').trim());
    // Thai leading vowels sit before the consonant, so keep the pair together.
    return /[เแโใไ]/.test(chars[0]) && chars[1] ? chars[0] + chars[1] : (chars[0] || '?').toUpperCase();
  }

  function renderUser() {
    var s = session();
    userBox.hidden = !s;
    signinBtn.hidden = !!s;
    root.classList.toggle('signed-in', !!s);
    root.classList.toggle('signed-out', !s);
    if (!s) return;
    var c = s.customer;
    var initial = initialOf(c.name);
    $('userAvatar').textContent = initial;
    $('userAvatarLg').textContent = initial;
    $('userName').textContent = String(c.name || '').split(' ')[0];
    $('userFull').textContent = c.name || '';
    $('userId').textContent = c.id || '';
    $('userEmail').textContent = c.email || '';
    $('userPhone').textContent = formatPhone(String(c.phone || ''));
    $('userDistrict').textContent = c.districtCode ? c.districtCode + ' · ' + (c.districtName || '') : '';
  }

  function toggleMenu(open) {
    userPop.hidden = !open;
    userBtn.setAttribute('aria-expanded', String(open));
    userBox.classList.toggle('is-open', open);
  }
  userBtn.addEventListener('click', function () { toggleMenu(userPop.hidden); });
  document.addEventListener('click', function (e) {
    if (!userPop.hidden && !userBox.contains(e.target)) toggleMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !userPop.hidden) { toggleMenu(false); userBtn.focus(); }
  });

  function openAuth(view) {
    if (root.classList.contains('auth-on')) return;
    root.classList.remove('auth-leaving');
    root.classList.add('auth-on');
    authEl.scrollTop = 0;
    showView(view || 'login');
    var first = firstInput(views[current]);
    if (first && finePointer) first.focus({ preventScroll: true });
    else $('authClose').focus({ preventScroll: true });
    loadDistricts(); // ready before the visitor reaches the register tab
  }

  function closeAuth() {
    if (!root.classList.contains('auth-on') || root.classList.contains('auth-leaving')) return;
    closeList();
    pending = null;
    root.classList.add('auth-leaving');
    setTimeout(function () {
      root.classList.remove('auth-on', 'auth-leaving');
      card.classList.remove('is-done', 'has-download');
      if (session()) {
        loginForm.reset();
        clearAlert(loginForm);
        hidePasswords(loginForm);
      }
      (session() ? userBtn : signinBtn).focus({ preventScroll: true });
    }, reduceMotion ? 0 : 340);
  }

  /* ---------- Members-only actions: scan, calculate, download the form ---------- */
  var pending = null; // what the visitor tried before signing in: { type, el }

  function requireLogin(type, el) {
    clearAlert(loginForm);
    openAuth('login');
    pending = { type: type, el: el };
    showAlert(loginForm, 'info', 'need_' + type);
  }

  function resume(p) {
    if (p.type === 'calc') {
      if (p.el.requestSubmit) p.el.requestSubmit();
      else p.el.querySelector('[type=submit]').click();
    } else {
      p.el.click();
    }
  }

  // Capture phase, so these run before app.js, scanner.js and mobile-app.js see the event.
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-auth-open]');
    if (opener) { openAuth(opener.dataset.authOpen); return; }
    var el = e.target.closest('[data-auth]');
    if (!el || el.tagName === 'FORM' || session()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    requireLogin(el.dataset.auth, el);
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.matches('[data-auth]') || session()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    requireLogin(form.dataset.auth, form);
  }, true);

  $('authDownload').addEventListener('click', function () { closeAuth(); });

  signinBtn.addEventListener('click', function () { openAuth('login'); });
  $('authClose').addEventListener('click', closeAuth);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented && root.classList.contains('auth-on')) closeAuth();
  });

  function signIn(customer) {
    write(SESSION_KEY, { customer: customer, at: Date.now() });
    renderUser();
    $('authWelcome').textContent = msg().welcome(customer.name);
    var p = pending;
    pending = null;
    card.classList.add('is-done');
    // Browsers block a PDF tab that opens without a click, so offer a button instead.
    if (p && p.type === 'download') { card.classList.add('has-download'); return; }
    setTimeout(function () {
      closeAuth();
      if (p) setTimeout(function () { resume(p); }, reduceMotion ? 20 : 380);
    }, reduceMotion ? 300 : 1300);
  }

  $('logoutBtn').addEventListener('click', function () {
    write(SESSION_KEY, null);
    toggleMenu(false);
    userBox.hidden = true;
    resetRegister();
    forgotForm.reset();
    resetForgotResult();
    clearAlert(forgotForm);
    clearAlert(loginForm);
    showView('login');
    renderUser();
    signinBtn.focus({ preventScroll: true });
  });

  /* ---------- Language and date ---------- */
  function renderDate() {
    $('authDate').textContent = new Date().toLocaleDateString(msg().date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  document.addEventListener('langchange', function () {
    renderDate();
    all('.afield').forEach(renderField);
    all('.auth__alert').forEach(function (box) { if (!box.hidden && box.dataset.key) renderAlert(box); });
    all('.afield__eye').forEach(renderEye);
    renderStatus();
    renderMeter();
    if (isOpen()) renderList();
    var s = session();
    if (s && card.classList.contains('is-done')) $('authWelcome').textContent = msg().welcome(s.customer.name);
  });

  /* ---------- Start ---------- */
  renderDate();
  renderMeter();
  all('.afield__eye').forEach(renderEye);
  renderUser();
})();
