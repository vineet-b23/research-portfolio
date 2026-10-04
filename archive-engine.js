/* ==========================================================================
   archive-engine.js
   Shared engine for ongoing.html, in-review.html, published.html and
   library.html. Pure vanilla JS, no dependencies.

   Reads   <body data-category="on-going | in review | published | library">
   Fetches data.json (written by sync-notion.js)
   Renders paper cards into  #archive-grid
   Searches via              #search-input   (keyup + input events)
   Library tabs via          button#filter-<key>   (library page only)

   Library tab keys:
     filter-all   every paper in the library
     filter-code  papers that have a link (paper.link)
     filter-<x>   any other key filters by topic, e.g. id="filter-nlp"
                  keeps papers with a topic containing "nlp"
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     1. CONFIG
     ====================================================================== */
  var DATA_URL = 'data.json';
  var PREVIEW_MAX = 120;

  // Normalized category -> statuses it may show. Anything not listed here
  // (including "Future Work") can never be rendered, even if it were in the JSON.
  var CATEGORIES = {
    ongoing: ['ongoing'],
    inreview: ['inreview'],
    published: ['published'],
    library: ['published', 'inreview']
  };

  var BADGES = {
    ongoing: { cls: 'badge-ongoing', label: 'On-going' },
    inreview: { cls: 'badge-review', label: 'In Review' },
    published: { cls: 'badge-published', label: 'Published' }
  };

  var FILTERS = {
    all: function () { return true; },
    code: function (entry) { return Boolean(entry.link); }
  };

  var state = {
    category: '',
    entries: [],
    loaded: false,
    query: '',
    filter: 'all',
    lastSignature: null
  };

  var grid = null;
  var input = null;
  var statusEl = null;

  /* ======================================================================
     2. SMALL HELPERS
     ====================================================================== */
  function byId(id) { return document.getElementById(id); }
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function str(value) { return value == null ? '' : String(value); }

  function safely(label, fn) {
    try { fn(); } catch (err) {
      if (window.console) { console.error('[archive-engine] ' + label + ' failed:', err); }
    }
  }

  // "On-going" -> "ongoing", "In Review" -> "inreview", "in review" -> "inreview"
  function normalizeKey(value) {
    return str(value).toLowerCase().replace(/[^a-z]/g, '');
  }

  // Lowercase, strip accents, collapse whitespace (for searching)
  function fold(value) {
    var s = str(value).toLowerCase();
    if (typeof s.normalize === 'function') { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
    return s.replace(/\s+/g, ' ').trim();
  }

  function topicKey(value) { return fold(value).replace(/[^a-z0-9]/g, ''); }

  // Allows http(s) links and relative URLs while blocking dangerous protocols (javascript:, data:)
  function safeHref(value) {
    var s = str(value).trim();
    if (!s || /^(?:javascript|data):/i.test(s)) { return ''; }
    return s;
  }

  function hostOf(link) {
    try {
      var u = new URL(str(link).trim());
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname.replace(/^www\./, '') : '';
    } catch (e) { return ''; }
  }

  // Max `max` characters including the ellipsis, cut on a word boundary where possible
  function preview(text, max) {
    if (text.length <= max) { return text; }
    var cut = text.slice(0, max - 1);
    var lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > max * 0.6) { cut = cut.slice(0, lastSpace); }
    return cut.replace(/[\s.,;:!?\-\u2013\u2014]+$/, '') + '\u2026';
  }

  // Element factory. Text always goes through textContent, so paper data can
  // never inject markup.
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  /* ======================================================================
     3. DATA
     ====================================================================== */
  // Turn one raw record from data.json into a safe, search-ready entry (or null)
  function toEntry(raw) {
    if (!raw || typeof raw !== 'object') { return null; }

    var rawUrl = raw.url || (raw.slug ? raw.slug + '.html' : '#');
    var url = safeHref(rawUrl) || '#';

    var title = str(raw.title).trim() || 'Untitled';
    var abstract = str(raw.abstract).replace(/\s+/g, ' ').trim();
    var topics = Array.isArray(raw.topics)
      ? raw.topics.map(function (t) { return str(t).trim(); }).filter(Boolean)
      : [];
    var link = hostOf(raw.link) ? str(raw.link).trim() : '';

    return {
      url: url,
      title: title,
      status: str(raw.status).trim(),
      statusKey: normalizeKey(raw.status),
      abstract: abstract,
      topics: topics,
      topicKeys: topics.map(topicKey),
      link: link,
      // "#NLP" and "nlp" should both match, so '#' is dropped from both sides
      haystack: fold([title, topics.join(' '), abstract].join(' ')).replace(/#/g, '')
    };
  }

  function tokensOf(query) {
    return fold(query).replace(/#/g, ' ').split(' ').filter(Boolean);
  }

  function filterPredicate(key) {
    if (has(FILTERS, key)) { return FILTERS[key]; }
    var wanted = topicKey(key);
    return function (entry) {
      return Boolean(wanted) && entry.topicKeys.some(function (t) { return t.indexOf(wanted) !== -1; });
    };
  }

  /* ======================================================================
     4. RENDERING
     ====================================================================== */
  function clearGrid() {
    while (grid.firstChild) { grid.removeChild(grid.firstChild); }
  }

  function showMessage(text, role) {
    clearGrid();
    var p = el('p', 'empty-state', text);
    if (role) { p.setAttribute('role', role); }
    grid.appendChild(p);
  }

  function buildCard(entry) {
    var card = el('a', 'bento-card archive-card');
    card.setAttribute('href', entry.url);

    // Top row: status badge + arrow
    var head = el('div', 'bento-card__head');
    var badgeInfo = has(BADGES, entry.statusKey) ? BADGES[entry.statusKey] : null;
    var badgeText = entry.status || (badgeInfo ? badgeInfo.label : '');
    if (badgeText) {
      head.appendChild(el('span', 'badge' + (badgeInfo ? ' ' + badgeInfo.cls : ''), badgeText));
    }
    var arrow = el('i', 'ph ph-arrow-up-right bento-card__arrow');
    arrow.setAttribute('aria-hidden', 'true');
    head.appendChild(arrow);
    card.appendChild(head);

    card.appendChild(el('h3', 'bento-card__title', entry.title));

    if (entry.abstract) {
      card.appendChild(el('p', 'bento-card__excerpt', preview(entry.abstract, PREVIEW_MAX)));
    }

    // Footer: topic pills, plus the artifact host on the library page
    var host = state.category === 'library' && entry.link ? hostOf(entry.link) : '';
    if (entry.topics.length || host) {
      var footer = el('div', 'bento-card__footer');
      entry.topics.forEach(function (topic) { footer.appendChild(el('span', 'topic', topic)); });
      if (host) {
        var artifact = el('span', 'archive-artifact');
        var icon = el('i', 'ph ph-link-simple');
        icon.setAttribute('aria-hidden', 'true');
        artifact.appendChild(icon);
        artifact.appendChild(document.createTextNode(host));
        footer.appendChild(artifact);
      }
      card.appendChild(footer);
    }

    return card;
  }

  function updateStatus(visibleCount) {
    if (!statusEl) { return; }
    var total = state.entries.length;
    if (!total) { statusEl.textContent = ''; return; }
    var noun = total === 1 ? ' paper' : ' papers';
    statusEl.textContent = visibleCount === total
      ? total + noun
      : visibleCount + ' of ' + total + ' papers';
  }

  function render(force) {
    if (!state.loaded) { return; }

    // Skip redundant renders (keyup and input both fire for a keystroke)
    var signature = state.filter + '\u0001' + state.query;
    if (!force && signature === state.lastSignature) { return; }
    state.lastSignature = signature;

    var tokens = tokensOf(state.query);
    var passesFilter = filterPredicate(state.filter);

    // Every search word must appear somewhere in title, topics or abstract
    var visible = state.entries.filter(function (entry) {
      return passesFilter(entry) && tokens.every(function (t) { return entry.haystack.indexOf(t) !== -1; });
    });

    if (!state.entries.length) {
      showMessage('No papers here yet. Check back soon.');
    } else if (!visible.length) {
      showMessage(tokens.length ? 'No papers found matching your query.' : 'No papers match this filter yet.');
    } else {
      clearGrid();
      var fragment = document.createDocumentFragment();
      visible.forEach(function (entry) { fragment.appendChild(buildCard(entry)); });
      grid.appendChild(fragment);
    }

    grid.setAttribute('aria-busy', 'false');
    updateStatus(visible.length);
  }

  /* ======================================================================
     5. SEARCH + LIBRARY TABS
     ====================================================================== */
  function initSearch() {
    if (!input) { return; }

    function onSearch() {
      state.query = input.value;
      render();
    }

    input.addEventListener('keyup', onSearch);
    input.addEventListener('input', onSearch);   // paste, autofill, mobile keyboards, clear button

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && input.value) {
        input.value = '';
        onSearch();
      }
    });
  }

  function initTabs() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button[id^="filter-"]'));
    if (!buttons.length) { return; }

    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        state.filter = button.id.slice('filter-'.length);
        buttons.forEach(function (other) {
          var on = other === button;
          other.classList.toggle('active', on);
          other.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        render();
      });
    });
  }

  /* ======================================================================
     6. DATA LOADING
     ====================================================================== */
  function load() {
    if (typeof fetch !== 'function') {
      showMessage('Your browser can\u2019t load this page. Please update it and try again.', 'alert');
      return;
    }

    var allowed = CATEGORIES[state.category];

    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) { throw new Error('HTTP ' + response.status); }
        return response.json();
      })
      .then(function (data) {
        var list = Array.isArray(data) ? data : (data && Array.isArray(data.papers) ? data.papers : null);
        if (!list) { throw new Error('data.json does not contain an array of papers'); }

        state.entries = list
          .map(toEntry)
          .filter(function (entry) { return entry && allowed.indexOf(entry.statusKey) !== -1; });
        state.loaded = true;
        if (input) { state.query = input.value; }   // keep text restored by the browser on back/forward
        render(true);
      })
      .catch(function (err) {
        if (window.console) { console.error('[archive-engine] Could not load ' + DATA_URL + ':', err); }
        grid.setAttribute('aria-busy', 'false');
        showMessage('Couldn\u2019t load the papers right now. Please refresh to try again.', 'alert');
      });
  }

  /* ======================================================================
     7. SITE CHROME (mobile menu, header shadow, footer year)
     These pages don't have index.html's inline script, so they live here.
     ====================================================================== */
  function initMenu() {
    var toggle = byId('nav-toggle');
    var drawer = byId('nav-drawer');
    if (!toggle || !drawer) { return; }

    function isOpen() { return toggle.getAttribute('aria-expanded') === 'true'; }

    function setOpen(open) {
      drawer.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      document.body.classList.toggle('no-scroll', open);
    }

    toggle.addEventListener('click', function () { setOpen(!isOpen()); });

    drawer.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a') : null;
      if (link) { setOpen(false); }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });

    if (window.matchMedia) {
      var desktop = window.matchMedia('(min-width: 900px)');
      var onChange = function (event) { if (event.matches) { setOpen(false); } };
      if (desktop.addEventListener) { desktop.addEventListener('change', onChange); }
      else if (desktop.addListener) { desktop.addListener(onChange); }
    }
  }

  function initHeaderState() {
    var header = document.querySelector('.site-header');
    if (!header) { return; }
    function update() { header.classList.toggle('is-scrolled', window.scrollY > 8); }
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  function initYear() {
    var yearEl = byId('footer-year');
    if (yearEl) { yearEl.textContent = String(new Date().getFullYear()); }
  }

  /* ======================================================================
     8. BOOT
     ====================================================================== */
  function init() {
    safely('menu', initMenu);
    safely('header state', initHeaderState);
    safely('year', initYear);

    grid = byId('archive-grid');
    input = byId('search-input');
    statusEl = byId('archive-status');
    if (!grid) { return; }

    state.category = normalizeKey(document.body && document.body.dataset ? document.body.dataset.category : '');
    if (!has(CATEGORIES, state.category)) {
      if (window.console) {
        console.error('[archive-engine] Missing or unknown data-category on <body>: "' +
          str(document.body && document.body.dataset && document.body.dataset.category) + '"');
      }
      showMessage('This page is not configured correctly.', 'alert');
      grid.setAttribute('aria-busy', 'false');
      return;
    }

    grid.setAttribute('aria-busy', 'true');
    showMessage('Loading papers\u2026');

    safely('search', initSearch);
    if (state.category === 'library') { safely('tabs', initTabs); }
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();