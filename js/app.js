(function () {
  'use strict';

  // Baht per 500 sq. cm, from the published rate table.
  var RATES = {
    changeable: { type1: 10, type2: 52, type3: 52 },
    fixed: { type1: 5, type2: 26, type3: 50 }
  };
  var INSTALLMENT_MIN = 3000;
  var LANG_KEY = 'signboard-tax-lang';

  var $ = function (id) { return document.getElementById(id); };
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var form = $('calcForm');
  var fields = { width: $('width'), length: $('length'), signType: $('signType'), fontType: $('fontType') };
  var output = $('taxValue');
  var resultBox = $('result');
  var breakdown = $('breakdown');
  var errorBox = $('calcError');
  var hint = $('installHint');
  var rateButtons = all('.rate__val');

  var lang = 'th';
  var state = null; // last calculation: { area, rate, tax }, or 'error'
  var animation = 0;

  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Language ---------- */
  var thai = {
    text: all('[data-i18n]').map(function (el) { return [el, el.innerHTML]; }),
    ph: all('[data-i18n-ph]').map(function (el) { return [el, el.placeholder]; }),
    alt: all('[data-i18n-alt]').map(function (el) { return [el, el.alt]; })
  };

  function storedLang() {
    var param = new URLSearchParams(location.search).get('lang');
    if (param === 'th' || param === 'en') return param;
    try {
      var saved = localStorage.getItem(LANG_KEY);
      return saved === 'en' ? 'en' : 'th';
    } catch (e) {
      return 'th';
    }
  }

  function setLang(next) {
    lang = next;
    var en = window.I18N_EN;
    var isEn = next === 'en';
    thai.text.forEach(function (p) {
      var value = en[p[0].dataset.i18n];
      p[0].innerHTML = isEn && value ? value : p[1];
    });
    thai.ph.forEach(function (p) { p[0].placeholder = isEn ? en[p[0].dataset.i18nPh] : p[1]; });
    thai.alt.forEach(function (p) { p[0].alt = isEn ? en[p[0].dataset.i18nAlt] : p[1]; });
    document.documentElement.lang = next;
    document.title = window.I18N_MESSAGES[next].title;
    all('.lang__btn').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === next)); });
    try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* storage unavailable */ }
    renderMessages();
  }

  all('.lang__btn').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.lang); });
  });

  /* ---------- Calculator ---------- */
  function money(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function positive(input) {
    var text = input.value.trim().replace(/,/g, '');
    var n = /^\d*\.?\d+$/.test(text) ? parseFloat(text) : NaN;
    return n > 0 ? n : NaN;
  }

  function animateTo(value) {
    cancelAnimationFrame(animation);
    if (reduceMotion) { output.textContent = money(value); return; }
    var start = performance.now();
    var duration = 650;
    (function frame(now) {
      var t = Math.min((now - start) / duration, 1);
      output.textContent = money(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) animation = requestAnimationFrame(frame);
    })(start);
  }

  function renderMessages() {
    var msg = window.I18N_MESSAGES[lang];
    var ok = state && state !== 'error';
    errorBox.hidden = state !== 'error';
    errorBox.textContent = state === 'error' ? msg.error : '';
    breakdown.hidden = !ok;
    breakdown.textContent = ok
      ? msg.breakdown(state.area.toLocaleString('en-US'), state.rate)
      : '';
    hint.hidden = !(ok && state.tax >= INSTALLMENT_MIN);
    hint.textContent = msg.installment;
  }

  function highlightRate() {
    rateButtons.forEach(function (b) {
      var active = b.dataset.sign === fields.signType.value && b.dataset.font === fields.fontType.value;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  function clearInvalid(el) {
    el.closest('.field').classList.remove('is-invalid');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var width = positive(fields.width);
    var length = positive(fields.length);
    var rate = (RATES[fields.signType.value] || {})[fields.fontType.value];

    var bad = [];
    if (!width) bad.push(fields.width);
    if (!length) bad.push(fields.length);
    if (!fields.signType.value) bad.push(fields.signType);
    if (!fields.fontType.value) bad.push(fields.fontType);
    Object.keys(fields).forEach(function (k) {
      fields[k].closest('.field').classList.toggle('is-invalid', bad.indexOf(fields[k]) !== -1);
    });

    if (bad.length) {
      state = 'error';
      cancelAnimationFrame(animation);
      output.textContent = '0.00';
      resultBox.classList.remove('is-done');
      renderMessages();
      bad[0].focus();
      return;
    }

    var area = width * length;
    var tax = area * rate / 500;
    state = { area: area, rate: rate, tax: tax };
    renderMessages();
    animateTo(tax);
    resultBox.classList.remove('is-done');
    void resultBox.offsetWidth; // restart the pulse animation
    resultBox.classList.add('is-done');
  });

  form.addEventListener('reset', function () {
    state = null;
    cancelAnimationFrame(animation);
    output.textContent = '0.00';
    resultBox.classList.remove('is-done');
    Object.keys(fields).forEach(function (k) { clearInvalid(fields[k]); });
    renderMessages();
    setTimeout(highlightRate); // field values are cleared after this event
  });

  Object.keys(fields).forEach(function (k) {
    fields[k].addEventListener('input', function () { clearInvalid(fields[k]); });
    fields[k].addEventListener('change', highlightRate);
  });

  // Clicking a rate in the table fills in the calculator's two dropdowns.
  rateButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      fields.signType.value = b.dataset.sign;
      fields.fontType.value = b.dataset.font;
      clearInvalid(fields.signType);
      clearInvalid(fields.fontType);
      highlightRate();
      $('calculator').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
      fields.width.focus({ preventScroll: true });
    });
  });

  /* ---------- Page chrome ---------- */
  var burger = $('burger');
  var nav = $('nav');
  function closeMenu() {
    nav.classList.remove('is-open');
    burger.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
  }
  burger.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    burger.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  var header = $('header');
  function onScroll() { header.classList.toggle('is-stuck', window.scrollY > 60); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var reveals = all('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    document.documentElement.classList.add('anim');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  setLang(storedLang());
})();
