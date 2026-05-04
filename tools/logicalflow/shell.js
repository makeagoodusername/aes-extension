// logicalflow — shell (vanilla JS port of shell.jsx).
// Exposes factory functions for the four chrome elements + the command
// palette. Each takes plain props and returns a real DOM node; callers
// are responsible for re-rendering on state change (the App owner does
// this with `render*`-style re-paint helpers).

(function () {
  'use strict';
  const { h, Icon } = window.LF;

  const MODULES = [
    { id: 'network',     label: 'Network map',     icon: 'map',      group: 'Operations' },
    { id: 'routes',      label: 'Routes',          icon: 'routes',   group: 'Operations' },
    { id: 'schedule',    label: 'Schedule',        icon: 'schedule', group: 'Operations' },
    { id: 'fleet',       label: 'Fleet',           icon: 'fleet',    group: 'Operations' },
    { id: 'maintenance', label: 'Maintenance',     icon: 'maint',    group: 'Operations' },
    { id: 'crew',        label: 'Crew',            icon: 'crew',     group: 'Operations' },
    { id: 'pricing',     label: 'Pricing & demand', icon: 'pricing', group: 'Revenue' },
    { id: 'finance',     label: 'Finance',         icon: 'finance',  group: 'Revenue' },
    { id: 'intel',       label: 'Competitor intel', icon: 'intel',   group: 'Revenue' },
    { id: 'bulk',        label: 'Bulk actions',    icon: 'bulk',     group: 'Tools' },
    { id: 'alerts',      label: 'Alerts & feed',   icon: 'alerts',   group: 'Tools' },
    { id: 'holdings',    label: 'Holdings',        icon: 'holdings', group: 'Tools' },
  ];

  // Placeholder ticker — wires to real AS market/airline data in a later slice.
  const TICKER = [
    { lbl: 'JET-A', val: '$0.94/gal', d: '—',     dir: '' },
    { lbl: 'USD',   val: '1.000',     d: '—',     dir: '' },
    { lbl: 'LF',    val: '—',         d: '',      dir: '' },
    { lbl: 'YIELD', val: '—',         d: '',      dir: '' },
    { lbl: 'CASK',  val: '—',         d: '',      dir: '' },
    { lbl: 'RASK',  val: '—',         d: '',      dir: '' },
  ];

  function Ticker(props) {
    const { now, alertCount, onCmdK, onAlerts } = props;
    const items = TICKER.concat(TICKER.slice(0, 4));
    const itemsEl = items.map((it, i) =>
      h('span', { class: 'item', key: i },
        h('span', { class: 'lbl' }, it.lbl),
        h('span', { class: 'val' }, it.val),
        h('span', { class: it.dir }, it.d)));

    const kbd = h('kbd', { style: { fontSize: '9px', padding: '1px 4px', border: '1px solid var(--line-2)', borderRadius: '2px', marginLeft: '4px' } }, '⌘K');
    const cmdBtn = h('button', { onclick: onCmdK }, Icon('cmd', 12), ' Command ', kbd);
    const alertBtn = h('button', { class: 'alert', onclick: onAlerts }, Icon('bell', 12),
      alertCount > 0 ? h('span', { class: 'badge' }, alertCount) : null);

    return h('div', { class: 'ticker' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark' }),
        h('b', null, 'logicalflow'),
        h('span', null, '/ AES')),
      h('div', { class: 'ticker-track' }, itemsEl),
      h('div', { class: 'ticker-right' },
        cmdBtn,
        alertBtn,
        h('div', { class: 'clock' },
          h('span', { class: 'pulse', style: { width: '5px', height: '5px', borderRadius: '50%', background: 'var(--pos)', boxShadow: '0 0 6px var(--pos)' } }),
          h('span', null, h('b', null, 'WK — / DAY —'), ' · CYCLE — / —'),
          h('span', { style: { color: 'var(--ink-3)' } }, now))));
  }

  function Rail(props) {
    const { active, onSelect, pinned, onTogglePin, collapsed, onToggleCollapse, airline } = props;
    const groups = {};
    MODULES.forEach(m => { (groups[m.group] = groups[m.group] || []).push(m); });
    const pinnedItems = MODULES.filter(m => pinned.indexOf(m.id) !== -1);

    function railItem(m, key) {
      const pinIcon = h('span', {
        class: 'pin ' + (pinned.indexOf(m.id) !== -1 ? 'pinned' : ''),
        onclick: (e) => { e.stopPropagation(); onTogglePin(m.id); },
      }, Icon(pinned.indexOf(m.id) !== -1 ? 'pin' : 'pinO', 11));
      return h('button', {
        key: key,
        class: 'rail-item',
        'aria-current': active === m.id ? 'true' : 'false',
        onclick: () => onSelect(m.id),
      },
        Icon(m.icon, 14),
        h('span', { class: 'label' }, m.label),
        m.meta ? h('span', { class: 'meta' }, m.meta) : null,
        pinIcon);
    }

    const sections = [];
    if (pinnedItems.length > 0 && !collapsed) {
      sections.push(h('div', { class: 'rail-section' }, 'Pinned'));
      sections.push(h('div', { class: 'rail-list' }, pinnedItems.map((m, i) => railItem(m, 'p' + m.id))));
    }
    Object.keys(groups).forEach(g => {
      sections.push(h('div', { class: 'rail-section' }, g));
      sections.push(h('div', { class: 'rail-list' }, groups[g].map(m => railItem(m, m.id))));
    });

    return h('aside', { class: 'rail' },
      h('div', { class: 'rail-head' },
        h('div', { class: 'airline-mark' }, airline.code),
        h('div', { class: 'airline' },
          h('b', null, airline.name),
          h('span', null, airline.code + ' · ' + airline.iata)),
        h('button', { class: 'switch', title: 'Switch airline' }, Icon('chevD', 10))),
      ...sections,
      h('div', { class: 'rail-foot' },
        h('button', { class: 'rail-item', onclick: onToggleCollapse },
          Icon(collapsed ? 'chevR' : 'chevL', 12),
          h('span', { class: 'label' }, 'Collapse')),
        h('button', { class: 'rail-item' }, Icon('settings', 12), h('span', { class: 'label' }, 'Settings')),
        h('button', { class: 'rail-item' }, Icon('help', 12), h('span', { class: 'label' }, 'Docs'))));
  }

  function Footer() {
    return h('div', { class: 'footer' },
      h('div', { class: 'seg' }, h('span', { class: 'dot' }), ' ', h('b', null, 'WS LIVE'), ' · sync —'),
      h('div', { class: 'seg' }, 'env ', h('b', null, '—')),
      h('div', { class: 'seg' }, 'tz ', h('b', null, 'UTC+00')),
      h('div', { class: 'seg' }, 'cargo ', h('b', null, '—')),
      h('div', { class: 'seg' }, 'pax ', h('b', null, '—')),
      h('div', { class: 'right' },
        h('div', { class: 'seg' }, 'logicalflow shell · slice 0'),
        h('div', { class: 'seg' }, '⌘K Command · ⌘B Sidebar · ? Help')));
  }

  function Crumb(path, actions) {
    const segs = [];
    path.forEach((p, i) => {
      segs.push(h('span', { class: 'seg ' + (i === path.length - 1 ? 'cur' : '') }, p));
      if (i < path.length - 1) segs.push(h('span', { class: 'div' }, '/'));
    });
    return h('div', { class: 'crumb' }, ...segs, h('div', { class: 'actions' }, actions || []));
  }

  // Command palette — shell-only payload (modules + a few stub actions).
  // Routes/airports get added once data ports land.
  function CommandPalette(props) {
    const { onClose, onJump } = props;
    const items = [
      ...MODULES.map(m => ({ id: m.id, label: m.label, group: 'Module' })),
      { id: 'theme-toggle',  label: 'Toggle theme (dark / light)', group: 'Action' },
      { id: 'cycle-accent',  label: 'Cycle accent color',         group: 'Action' },
    ];
    const input = h('input', { placeholder: 'Jump to module or action…' });
    const results = h('div', { class: 'results' });

    function render(q) {
      results.innerHTML = '';
      const filt = items.filter(it => it.label.toLowerCase().includes(q.toLowerCase()));
      if (filt.length === 0) {
        results.appendChild(h('div', { class: 'res', style: { color: 'var(--ink-4)' } }, 'No matches'));
        return;
      }
      filt.slice(0, 12).forEach((it, i) => {
        const row = h('div', {
          class: 'res',
          'aria-selected': i === 0 ? 'true' : 'false',
          onclick: () => onJump(it),
        },
          Icon(it.group === 'Module' ? 'chevR' : it.group === 'Action' ? 'plus' : 'map', 12),
          ' ', it.label,
          h('span', { class: 'grp' }, it.group));
        results.appendChild(row);
      });
    }
    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter') {
        const first = results.querySelector('.res[aria-selected="true"]');
        if (first) first.click();
      }
    });
    render('');
    setTimeout(() => input.focus(), 30);

    const scrim = h('div', { class: 'scrim', onclick: onClose });
    const palette = h('div', { class: 'cmd' }, input, results);
    const frag = document.createDocumentFragment();
    frag.appendChild(scrim);
    frag.appendChild(palette);
    return frag;
  }

  window.LF = Object.assign(window.LF || {}, {
    MODULES, Ticker, Rail, Footer, Crumb, CommandPalette,
  });
})();
