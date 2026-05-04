// logicalflow — primitives (vanilla JS port of primitives.jsx).
// Exposes a tiny `h()` DOM builder, an Icon factory, formatters, and
// shared component factories (Panel, Kpi, Pill, Bar, Sparkline). All
// returns are real DOM nodes, not virtual ones — callers append directly.

(function () {
  'use strict';

  // h(tag, attrs?, ...children) — minimal hyperscript over DOM APIs.
  // attrs supports: string/number values, boolean for presence-only attrs,
  // `style` as object, `class`/`className`, and on* event handlers.
  function h(tag, attrs, ...children) {
    const el = tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect' || tag === 'g'
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag);
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'style' && typeof v === 'object') {
          Object.assign(el.style, v);
        } else if (k === 'class' || k === 'className') {
          el.setAttribute('class', v);
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, v);
        }
      }
    } else if (attrs != null) {
      // attrs slot was actually a child
      children.unshift(attrs);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // SVG icon paths — copy of primitives.jsx Icon set, expressed as raw
  // markup strings so we can stamp them via innerHTML on a fresh <svg>.
  const ICONS = {
    network: '<circle cx="8" cy="3" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="13" cy="13" r="1.5"/><path d="M8 4.5 L4 11.5 M8 4.5 L12 11.5 M4.5 13 L11.5 13"/>',
    fleet: '<path d="M8 1.5 L9.5 7 L14.5 9 L9.5 10 L9 13.5 L8 11.5 L7 13.5 L6.5 10 L1.5 9 L6.5 7 Z"/>',
    routes: '<circle cx="3" cy="13" r="1.2"/><circle cx="13" cy="3" r="1.2"/><path d="M3.5 12.5 Q4 4 12.5 3.5"/>',
    pricing: '<path d="M3 8 H13 M3 11 H10 M3 5 H11"/><circle cx="11" cy="5" r="1"/><circle cx="10" cy="11" r="1"/>',
    schedule: '<rect x="2" y="3" width="12" height="11" rx="1"/><path d="M2 6 H14 M5 1.5 V4 M11 1.5 V4 M5 9 H7 M9 9 H11 M5 12 H7"/>',
    maint: '<path d="M11.5 4.5 L12.5 5.5 L9.5 8.5 M9.5 8.5 L4.5 13.5 L2.5 13.5 L2.5 11.5 L7.5 6.5 M9.5 8.5 L7.5 6.5 M11 3 L13 5"/>',
    finance: '<path d="M2 13 H14 M3 13 V8 M6 13 V5 M9 13 V9 M12 13 V3"/>',
    intel: '<circle cx="7" cy="7" r="4"/><path d="M10 10 L13.5 13.5"/>',
    crew: '<circle cx="8" cy="5" r="2.2"/><path d="M3 13.5 Q3 9.5 8 9.5 Q13 9.5 13 13.5"/>',
    bulk: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
    alerts: '<path d="M8 2 L8 2 Q3.5 2 3.5 7 V10 L2.5 11.5 H13.5 L12.5 10 V7 Q12.5 2 8 2 M6.5 13 Q6.5 14.5 8 14.5 Q9.5 14.5 9.5 13"/>',
    holdings: '<path d="M2 13 H14 M3 13 V6 L8 3 L13 6 V13 M6 13 V9 H10 V13"/>',
    map: '<path d="M2 4 L6 2.5 L10 4 L14 2.5 V11.5 L10 13 L6 11.5 L2 13 Z M6 2.5 V11.5 M10 4 V13"/>',
    pin: '<path d="M8 1.5 Q4 1.5 4 5.5 Q4 9 8 14 Q12 9 12 5.5 Q12 1.5 8 1.5"/><circle cx="8" cy="5.5" r="1.5"/>',
    pinO: '<path d="M8 1.5 Q4 1.5 4 5.5 Q4 9 8 14 Q12 9 12 5.5 Q12 1.5 8 1.5"/>',
    settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5 V3 M8 13 V14.5 M14.5 8 H13 M3 8 H1.5 M12.5 3.5 L11.5 4.5 M4.5 11.5 L3.5 12.5 M12.5 12.5 L11.5 11.5 M4.5 4.5 L3.5 3.5"/>',
    help: '<circle cx="8" cy="8" r="6"/><path d="M6 6.5 Q6 5 8 5 Q10 5 10 6.5 Q10 7.5 8 8.5 V9.5 M8 11.2 V11.5"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="M10 10 L13.5 13.5"/>',
    plus: '<path d="M8 3 V13 M3 8 H13"/>',
    chevR: '<path d="M6 3 L11 8 L6 13"/>',
    chevL: '<path d="M10 3 L5 8 L10 13"/>',
    chevD: '<path d="M3 6 L8 11 L13 6"/>',
    download: '<path d="M8 2 V11 M4.5 7.5 L8 11 L11.5 7.5 M3 13.5 H13"/>',
    cmd: '<path d="M5 3 V13 M11 3 V13 M3 5 H13 M3 11 H13"/>',
    bell: '<path d="M8 2 L8 2 Q4 2 4 7 V10 L3 11.5 H13 L12 10 V7 Q12 2 8 2 M6.5 13 Q6.5 14.5 8 14.5 Q9.5 14.5 9.5 13"/>',
    refresh: '<path d="M3 4 V8 H7 M13 12 V8 H9 M3 8 Q3 3 8 3 Q11 3 13 5 M13 8 Q13 13 8 13 Q5 13 3 11"/>',
    layers: '<path d="M8 2 L1.5 5.5 L8 9 L14.5 5.5 Z M2.5 8 L8 11 L13.5 8 M2.5 10.5 L8 13.5 L13.5 10.5"/>',
    eye: '<path d="M1 8 Q4 3 8 3 Q12 3 15 8 Q12 13 8 13 Q4 13 1 8"/><circle cx="8" cy="8" r="2"/>',
    play: '<path d="M4 3 L13 8 L4 13 Z"/>',
    pause: '<rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/>',
    sort: '<path d="M5 3 L5 13 M3 5 L5 3 L7 5 M11 3 L11 13 M9 11 L11 13 L13 11"/>',
    filter: '<path d="M2 3 H14 L9.5 8.5 V13 L6.5 11.5 V8.5 Z"/>',
    expand: '<path d="M3 8 V3 H8 M13 8 V13 H8 M3 3 L7 7 M13 13 L9 9"/>',
    history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5 V8 L10.5 9.5"/>',
    star: '<path d="M8 1.5 L9.6 6 L14 6 L10.5 9 L11.8 13.5 L8 11 L4.2 13.5 L5.5 9 L2 6 L6.4 6 Z"/>',
    grid: '<rect x="2.5" y="2.5" width="4" height="4"/><rect x="9.5" y="2.5" width="4" height="4"/><rect x="2.5" y="9.5" width="4" height="4"/><rect x="9.5" y="9.5" width="4" height="4"/>',
    list: '<path d="M5 4 H14 M5 8 H14 M5 12 H14 M2.5 4 H2.6 M2.5 8 H2.6 M2.5 12 H2.6"/>',
    x: '<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5 V3 M8 13 V14.5 M14.5 8 H13 M3 8 H1.5 M12.5 3.5 L11.5 4.5 M4.5 11.5 L3.5 12.5 M12.5 12.5 L11.5 11.5 M4.5 4.5 L3.5 3.5"/>',
    moon: '<path d="M13 9.5 Q11 12 8 12 Q4 12 4 8 Q4 5 6.5 3 Q6 6.5 8.5 9 Q11 11 13 9.5"/>',
  };

  function Icon(name, size) {
    size = size || 14;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = ICONS[name] || '<circle cx="8" cy="8" r="3"/>';
    return svg;
  }

  // Formatters — same shapes as primitives.jsx.
  const fmtMoney = (n, d = 0) => {
    if (n == null) return '—';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(d === 0 ? 2 : d) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(d === 0 ? 2 : d) + 'M';
    if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(d === 0 ? 1 : d) + 'k';
    return sign + '$' + a.toFixed(d);
  };
  const fmtNum = (n, d = 0) => n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = (n, d = 1) => (n * 100).toFixed(d) + '%';
  const fmtSign = (n, d = 0) => (n > 0 ? '+' : '') + (typeof n === 'number' ? n.toFixed(d) : n);

  function Panel(opts) {
    opts = opts || {};
    const head = (opts.title || opts.right)
      ? h('div', { class: 'panel-head' },
          opts.title ? h('div', { class: 'title' }, opts.title) : null,
          opts.right ? h('div', { class: 'right' }, opts.right) : null)
      : null;
    const body = h('div', { class: 'panel-body ' + (opts.bodyClass || 'tight') }, opts.children || []);
    return h('div', { class: 'panel ' + (opts.className || '') }, head, body);
  }

  function Kpi(lbl, val, delta, deltaKind) {
    return h('div', { class: 'kpi' },
      h('div', { class: 'lbl' }, lbl),
      h('div', { class: 'val' }, val),
      delta ? h('div', { class: 'delta ' + (deltaKind || '') }, delta) : null);
  }

  function Pill(text, kind) {
    return h('span', { class: 'pill ' + (kind || '') }, text);
  }

  function Bar(value, max, kind) {
    max = max || 1;
    const fill = h('div');
    fill.style.width = Math.min(100, (value / max) * 100) + '%';
    return h('div', { class: 'bar ' + (kind || '') }, fill);
  }

  function Sparkline(data, opts) {
    opts = opts || {};
    const width = opts.width || 80, height = opts.height || 24;
    if (!data || data.length < 2) return h('span');
    const min = Math.min(...data), max = Math.max(...data);
    const span = max - min || 1;
    const stepX = width / (data.length - 1);
    const pts = data.map((v, i) => [i * stepX, height - ((v - min) / span) * height]);
    const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = path + ' L ' + width + ' ' + height + ' L 0 ' + height + ' Z';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.style.display = 'block';
    const cls = 'spark' + (opts.kind ? ' ' + opts.kind : '');
    svg.innerHTML = '<path d="' + path + '" class="' + cls + '"/>' + (opts.area === false ? '' : '<path d="' + area + '" class="spark-area"/>');
    return svg;
  }

  window.LF = Object.assign(window.LF || {}, {
    h, Icon, Panel, Kpi, Pill, Bar, Sparkline,
    fmtMoney, fmtNum, fmtPct, fmtSign,
  });
})();
