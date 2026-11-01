// On phones the page runs as an app: one screen at a time, switched from a
// bottom tab bar. Above the breakpoint the page is a normal scrolling site and
// the same five destinations sit in the header, scrolling to their sections.
(function () {
  'use strict';

  var INSTALL_KEY = 'signboard-tax-install-dismissed';
  var SCREENS = ['home', 'rates', 'calc', 'guide', 'contact'];

  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var phone = matchMedia('(max-width:760px)');
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var current = 'home';
  var scrollPos = {};

  function isApp() { return root.classList.contains('app'); }
  function tap() { if (navigator.vibrate) navigator.vibrate(8); }

  /* ---------- Screens ---------- */
  function updateTitle() {
    var tab = document.querySelector('[data-go="' + current + '"] .tabbar__label');
    $('screenTitle').textContent = tab ? tab.textContent : '';
  }

  function show(name) {
    if (SCREENS.indexOf(name) === -1) name = 'home';
    var changed = name !== current;
    if (changed && isApp()) scrollPos[current] = window.scrollY;
    current = name;
    root.dataset.screen = name;
    all('[data-screen]').forEach(function (el) {
      el.classList.toggle('is-current', el.dataset.screen === name);
    });
    all('.tabbar__item').forEach(function (b) {
      if (b.dataset.go === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    updateTitle();
    if (changed && isApp()) window.scrollTo(0, scrollPos[name] || 0);
  }

  // Screens live in the URL so the phone's back button moves between them.
  function go(name) {
    var hash = '#/' + name;
    if (location.hash === hash) show(name);
    else location.hash = hash;
  }

  function fromHash() {
    var hash = location.hash;
    if (hash === '#calculator') return 'calc';
    return hash.indexOf('#/') === 0 ? hash.slice(2) : 'home';
  }

  window.addEventListener('hashchange', function () { show(fromHash()); });

  document.addEventListener('click', function (e) {
    var target = e.target.closest('[data-go], .rate__val, a[href="#calculator"], a[href="#top"]');
    if (!target) return;
    if (!isApp()) {
      if (target.dataset.go) { e.preventDefault(); scrollToScreen(target.dataset.go); }
      return;
    }
    e.preventDefault();
    tap();
    if (target.dataset.go) go(target.dataset.go);
    else if (target.classList.contains('rate__val') || target.getAttribute('href') === '#calculator') go('calc');
    else go('home');
  });

  document.addEventListener('langchange', updateTitle);

  /* ---------- Desktop header menu ---------- */
  function sectionFor(name) {
    return document.querySelector('[data-screen="' + name + '"]:not(.app-only)');
  }

  function scrollToScreen(name) {
    if (name === 'home') window.scrollTo(0, 0);
    else sectionFor(name).scrollIntoView();
  }

  // Highlights the section being read.
  function markCurrentSection() {
    if (isApp()) return;
    var active = 'home';
    SCREENS.forEach(function (name) {
      if (sectionFor(name).getBoundingClientRect().top <= 140) active = name;
    });
    if (window.innerHeight + window.scrollY >= root.scrollHeight - 2) active = 'contact';
    all('.topnav__item').forEach(function (b) {
      if (b.dataset.go === active) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
  }
  window.addEventListener('scroll', markCurrentSection, { passive: true });

  /* ---------- Guide accordion ---------- */
  var heads = all('.guide__body h3');
  heads.forEach(function (head, i) {
    var body = document.createElement('div');
    body.className = 'acc__body';
    head.parentNode.insertBefore(body, head);
    body.parentNode.insertBefore(head, body);
    while (body.nextSibling && body.nextSibling.nodeName !== 'H3') body.appendChild(body.nextSibling);
    function toggle() {
      if (!isApp()) return;
      var open = head.classList.toggle('is-open');
      head.setAttribute('aria-expanded', String(open));
      tap();
    }
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    if (i === 0) head.classList.add('is-open');
  });

  /* ---------- Calculator ---------- */
  $('calcForm').addEventListener('submit', function () {
    if (!isApp()) return;
    tap();
    if ($('calcError').hidden) {
      if (document.activeElement) document.activeElement.blur(); // dismiss the keyboard
      $('result').scrollIntoView({ block: 'center' });
    }
  });

  /* ---------- Mode ---------- */
  function applyMode() {
    var app = phone.matches;
    root.classList.toggle('app', app);
    markCurrentSection();
    heads.forEach(function (head) {
      if (app) {
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.setAttribute('aria-expanded', String(head.classList.contains('is-open')));
      } else {
        head.removeAttribute('role');
        head.removeAttribute('tabindex');
        head.removeAttribute('aria-expanded');
      }
    });
  }
  phone.addEventListener('change', applyMode);
  applyMode();
  show(fromHash());

  /* ---------- Install ---------- */
  var card = $('installCard');
  var promptEvent = null;
  var msg = function () { return window.I18N_MESSAGES[root.lang === 'en' ? 'en' : 'th']; };
  var iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function dismissed() {
    try { return localStorage.getItem(INSTALL_KEY) === '1'; } catch (e) { return false; }
  }
  function renderInstall() {
    if (standalone || dismissed() || !(promptEvent || iOS)) { card.hidden = true; return; }
    card.hidden = false;
    $('installText').textContent = promptEvent ? msg().installAndroid : msg().installIos;
    $('installGo').hidden = !promptEvent;
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    promptEvent = e;
    renderInstall();
  });
  window.addEventListener('appinstalled', function () { promptEvent = null; card.hidden = true; });
  $('installGo').addEventListener('click', function () {
    if (!promptEvent) return;
    promptEvent.prompt();
    promptEvent = null;
    renderInstall();
  });
  $('installClose').addEventListener('click', function () {
    try { localStorage.setItem(INSTALL_KEY, '1'); } catch (e) { /* storage unavailable */ }
    card.hidden = true;
  });
  document.addEventListener('langchange', renderInstall);
  renderInstall();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* still works online */ });
  }
})();
