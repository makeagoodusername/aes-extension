// logicalflow — top-level controller (vanilla JS port of app.jsx).
// Owns app state (active module, pinned list, collapse, theme, accent),
// persists tweaks via chrome.storage.local when available, and re-paints
// the shell on state change. Module bodies render as "not yet ported"
// placeholders for slice 0; later slices will swap each one in.

(function () {
  'use strict';
  const { h, Icon, MODULES, Ticker, Rail, Footer, Crumb, CommandPalette } = window.LF;

  const ACCENT_PRESETS = {
    cyan:   'oklch(0.78 0.13 200)',
    amber:  'oklch(0.82 0.14 75)',
    green:  'oklch(0.78 0.15 150)',
    violet: 'oklch(0.72 0.15 290)',
    rose:   'oklch(0.74 0.16 25)',
  };
  const ACCENT_ORDER = Object.keys(ACCENT_PRESETS);
  const STORAGE_KEY = 'lf:tweaks:v1';
  const PINNED_KEY  = 'lf:pinned:v1';

  // Until real airline context lands, ship a neutral placeholder rather
  // than the prototype's fictional Meridian Pacific data.
  const AIRLINE = { code: 'AES', iata: 'AES / —', name: 'logicalflow shell' };

  const state = {
    mod: 'network',
    pinned: ['network', 'routes', 'fleet'],
    collapsed: false,
    cmdOpen: false,
    now: '',
    tweaks: { theme: 'dark', accent: 'cyan' },
  };

  // Persistence — chrome.storage.local when available (extension page),
  // localStorage otherwise (so the page also works opened directly).
  const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? {
    get: (k) => new Promise(r => chrome.storage.local.get(k, v => r(v[k]))),
    set: (k, v) => new Promise(r => chrome.storage.local.set({ [k]: v }, r)),
  } : {
    get: async (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: async (k, v) => { localStorage.setItem(k, JSON.stringify(v)); },
  };

  async function loadPersisted() {
    const t = await storage.get(STORAGE_KEY);
    if (t && typeof t === 'object') Object.assign(state.tweaks, t);
    const p = await storage.get(PINNED_KEY);
    if (Array.isArray(p)) state.pinned = p;
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.tweaks.theme);
    document.documentElement.style.setProperty('--accent',
      ACCENT_PRESETS[state.tweaks.accent] || ACCENT_PRESETS.cyan);
  }

  function setTweak(k, v) {
    state.tweaks[k] = v;
    storage.set(STORAGE_KEY, state.tweaks);
    applyTheme();
    paint();
  }

  function setPinned(next) {
    state.pinned = next;
    storage.set(PINNED_KEY, next);
    paint();
  }

  // Module body — for slice 0 every module renders the same placeholder
  // panel. Later slices register real renderers via window.LF.modules[id].
  function renderModuleBody(id) {
    const reg = (window.LF.modules || {})[id];
    if (typeof reg === 'function') return reg();
    const m = MODULES.find(x => x.id === id);
    const label = m ? m.label : id;
    return h('div', { class: 'module-body', style: { padding: '24px' } },
      h('div', { class: 'placeholder', style: { maxWidth: '520px', margin: '40px auto', padding: '32px' } },
        h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--ink-3)', marginBottom: '8px' } }, m ? m.group : ''),
        h('div', { style: { fontSize: '20px', color: 'var(--ink-1)', marginBottom: '6px', fontFamily: 'var(--font-mono)' } }, label),
        h('div', { style: { color: 'var(--ink-3)' } }, 'Module body not yet ported.'),
        h('div', { style: { marginTop: '12px', fontSize: '10px', color: 'var(--ink-4)' } }, 'Shell slice — chrome only. Module renderers come in later slices.')));
  }

  // Crumb actions — shell-level controls (theme + accent + collapse) so
  // the shell is self-contained without a modules-only Tweaks panel.
  function crumbActions() {
    const themeBtn = h('button', {
      title: 'Toggle theme',
      onclick: () => setTweak('theme', state.tweaks.theme === 'dark' ? 'light' : 'dark'),
    }, Icon(state.tweaks.theme === 'dark' ? 'sun' : 'moon', 12), ' ', state.tweaks.theme === 'dark' ? 'Light' : 'Dark');

    const idx = ACCENT_ORDER.indexOf(state.tweaks.accent);
    const accentBtn = h('button', {
      title: 'Cycle accent',
      onclick: () => setTweak('accent', ACCENT_ORDER[(idx + 1) % ACCENT_ORDER.length]),
    },
      h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', boxShadow: '0 0 4px var(--accent)' } }),
      ' ', state.tweaks.accent);

    return [themeBtn, accentBtn];
  }

  // Single-pass paint. The shell is small enough that wholesale repaint
  // each state change is fine — keeps state→DOM logic trivial.
  function paint() {
    const root = document.getElementById('root');
    root.innerHTML = '';

    const app = h('div', { class: 'lf-app', 'data-rail': state.collapsed ? 'collapsed' : 'open' });

    app.appendChild(Ticker({
      now: state.now,
      alertCount: 0,
      onCmdK: () => { state.cmdOpen = !state.cmdOpen; paint(); },
      onAlerts: () => { state.mod = 'alerts'; paint(); },
    }));

    app.appendChild(Rail({
      active: state.mod,
      onSelect: (id) => { state.mod = id; paint(); },
      pinned: state.pinned,
      onTogglePin: (id) => setPinned(state.pinned.indexOf(id) !== -1 ? state.pinned.filter(x => x !== id) : state.pinned.concat([id])),
      collapsed: state.collapsed,
      onToggleCollapse: () => { state.collapsed = !state.collapsed; paint(); },
      airline: AIRLINE,
    }));

    const m = MODULES.find(x => x.id === state.mod);
    const main = h('main', { class: 'main' },
      Crumb([m ? m.group : '', m ? m.label : state.mod], crumbActions()),
      renderModuleBody(state.mod));
    app.appendChild(main);

    app.appendChild(Footer());

    if (state.cmdOpen) {
      app.appendChild(CommandPalette({
        onClose: () => { state.cmdOpen = false; paint(); },
        onJump: (item) => {
          if (item.group === 'Module') { state.mod = item.id; }
          else if (item.id === 'theme-toggle') { state.tweaks.theme = state.tweaks.theme === 'dark' ? 'light' : 'dark'; storage.set(STORAGE_KEY, state.tweaks); applyTheme(); }
          else if (item.id === 'cycle-accent') { const i = ACCENT_ORDER.indexOf(state.tweaks.accent); state.tweaks.accent = ACCENT_ORDER[(i + 1) % ACCENT_ORDER.length]; storage.set(STORAGE_KEY, state.tweaks); applyTheme(); }
          state.cmdOpen = false;
          paint();
        },
      }));
    }

    root.appendChild(app);
  }

  function tickClock() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const tz = -d.getTimezoneOffset() / 60;
    const tzs = (tz >= 0 ? '+' : '') + tz;
    state.now = `${hh}:${mm}:${ss} UTC${tzs}`;
    // Cheap update — only re-paint if visible bits changed (every second).
    paint();
  }

  function bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); state.cmdOpen = !state.cmdOpen; paint(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); state.collapsed = !state.collapsed; paint(); }
      else if (e.key === 'Escape' && state.cmdOpen) { state.cmdOpen = false; paint(); }
    });
  }

  (async function boot() {
    await loadPersisted();
    applyTheme();
    bindShortcuts();
    tickClock();
    setInterval(tickClock, 1000);
  })();
})();
