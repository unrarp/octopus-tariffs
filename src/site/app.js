import { annualCost } from './lib/cost.js';

// The family line colours, slot n going to the n-th family in families.json (categorical: fixed order, never cycled, so
// a family keeps its colour when another is added after it). Each slot is [light, dark]: the dataviz reference palette's
// blue, green, violet, orange in its light and dark steps. Validated with the dataviz skill's validate_palette.js on
// 2026-10-21 against the chart surfaces in app.css: `"#2a78d6,#008300,#6250d6,#eb6834" --mode light --surface "#fcfcfb"`
// and `"#3987e5,#008300,#9085e9,#d95926" --mode dark --surface "#1a1a19"`: every check PASS in both, no WARN (worst
// adjacent CVD ΔE 26.5 light / 26.0 dark, normal-vision 29.0 / 27.0, all >= 3:1 on the surface). The reference's default
// first four (blue, orange, aqua, yellow) WARN on light contrast. Changing a colour, the order or the count: re-run both
// commands and keep only an order that passes both. The cap is never a categorical hue: grey and dashed (--cap in app.css).
const PALETTE = [
  ['#2a78d6', '#3987e5'],
  ['#008300', '#008300'],
  ['#6250d6', '#9085e9'],
  ['#eb6834', '#d95926'],
];
const DAY = 86_400_000;
const WINDOWS = ['6', '12', '24', 'all']; // months back from the right edge, smallest first
const REGION_KEY = 'octopus-tariffs:region';
const USAGE_KEY = 'octopus-tariffs:usage';
const PANELS = [
  { id: 'electricity-unit', fuel: 'electricity', field: 'unit', unit: 'p/kWh' },
  { id: 'electricity-standing', fuel: 'electricity', field: 'standingCharge', unit: 'p/day' },
  { id: 'gas-unit', fuel: 'gas', field: 'unit', unit: 'p/kWh' },
  { id: 'gas-standing', fuel: 'gas', field: 'standingCharge', unit: 'p/day' },
];

const $ = (id) => document.getElementById(id);
const el = (tag, { dataset, style, ...props } = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  Object.assign(n.dataset, dataset ?? {});
  if (style) n.setAttribute('style', style);
  n.append(...kids);
  return n;
};
// The canvas cannot use CSS variables, so the charts resolve them at paint time through a hidden element's colour; a
// light-dark() pair resolves for the current scheme. Nothing is cached, so a scheme change needs only a redraw.
const ink = Object.assign(document.createElement('i'), { hidden: true });
const css = (value) => {
  ink.style.color = value.startsWith('--') ? `var(${value})` : value;
  return getComputedStyle(ink).color;
};
const pair = ([light, dark]) => `light-dark(${light}, ${dark})`;
const get = (path, init) =>
  fetch(path, init).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });
const remembered = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

// Days are UTC calendar dates on the axis; the build already dated every rate by its UK day.
const ms = (day) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (day, n) => dayOf(ms(day) + n * DAY);
/** `day` moved by `n` months, clamped to the month's end (31 Aug − 6 months is 28 Feb), as in src/days.js. */
const addMonths = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
  return dayOf(Date.UTC(y, m - 1 + n, Math.min(d, last)));
};
const fmtDate = (day) =>
  new Date(ms(day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const pounds = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;
const pence = (v) => v.toFixed(v < 10 ? 2 : 1);

async function main() {
  document.body.append(ink);
  const meta = await get('./data/families.json');
  if (meta.families.length > PALETTE.length)
    throw new Error(
      `families.json lists ${meta.families.length} families; PALETTE has ${PALETTE.length} validated colours`,
    );
  const regionName = (r) => meta.regions[r];

  // ---- definitions: one entry each, linked from every use with term(id, text) ----
  const tdcv = meta.tdcv;
  const DEFS = {
    unit: ['Unit rate', 'What you pay for each kWh you use, in pence (p/kWh), VAT included.'],
    standing: [
      'Standing charge',
      'A fixed daily charge for being connected, in pence a day (p/day), VAT included, paid whatever you use.',
    ],
    vat: [
      'Prices inc VAT',
      "Every price includes VAT at the rate in force on that day, worked out from Octopus's prices before VAT.",
    ],
    signup: [
      'If you signed up that day',
      'Each line follows the version of the tariff that was on sale on each day: its rates as a new customer would have got them. A fixed tariff then keeps the rates of the day you signed up for its fixed term.',
    ],
    onsale: [
      'On sale',
      'A version is on sale from its launch until the next version launches or Octopus withdraws it. A gap in a line: no version was on sale in your region. "Not on sale": none is today. "Not sold in" a region: the tariff has never been sold there.',
    ],
    fixed: [
      'Fixed term',
      'A fixed tariff (18M, 12M or 6M Winter Fix) keeps its unit rates and standing charges for its term, 18, 12 or 6 months from the day you sign up, with an exit fee to leave early. Its rates can still step when a levy or VAT change passes through.',
    ],
    variable: [
      'Variable',
      'A variable tariff (Flexible Octopus) has no term and no exit fee; its rates move, usually when the price cap changes.',
    ],
    annual: [
      'Estimated annual cost',
      "Unit rate × your kWh a year + standing charge × 365, VAT included, for each fuel you have, added up: a full year at that day's rates. An estimate, not a bill: a real bill follows when you use energy and how rates change. Per month divides every figure by 12. With the gas field empty, gas is left out, standing charge included.",
    ],
    tdcv: [
      'Typical Domestic Consumption Values (TDCV)',
      `Ofgem's typical home: ${tdcv.electricity.toLocaleString('en-GB')} kWh of electricity and ${tdcv.gas.toLocaleString('en-GB')} kWh of gas a year, as revised on 1 July 2026 (Ofgem, "Summary of changes to energy price cap 1 July to 30 September 2026, revised TDCV"). The page starts from these; your bill shows your own kWh a year. Leave gas empty if you have no gas supply.`,
    ],
    cap: [
      'Price cap',
      "Ofgem's default tariff cap: the most a supplier may charge per kWh and per day on a standard variable tariff, set by Ofgem for each region every quarter. A limit on rates, not a recommended tariff or an average bill. Source: Ofgem's published cap levels, entered by hand each quarter; the grey dashed line stops at the last period entered.",
    ],
    notyet: ['Not yet collected', 'The hatched days after the last data update: prices are collected once a day.'],
    region: [
      'Region',
      'Prices differ between the 14 electricity regions. The first visit guesses yours from your IP address; pick yours to correct it and this browser remembers it.',
    ],
    data: [
      'Data',
      "Octopus Energy's public API: every version of each tariff with its full rate history, direct debit, collected daily. Ofgem's price cap levels are entered by hand from Ofgem's announcements.",
    ],
  };
  const term = (id, text) =>
    el('a', { className: 'term', href: `#fn-${id}`, title: `${DEFS[id][0]}: ${DEFS[id][1]}`, textContent: text });
  $('defs').replaceChildren(
    ...Object.entries(DEFS).map(([id, [name, text]]) =>
      el('div', { id: `fn-${id}` }, el('dt', { textContent: name }), el('dd', { textContent: text })),
    ),
  );
  const help = $('help');
  const openHelp = (id) => {
    if (!help.open) help.showModal();
    for (const d of $('defs').children) d.classList.toggle('current', d.id === `fn-${id}`);
    if (id) $(`fn-${id}`).scrollIntoView({ block: 'center' });
    else help.scrollTop = 0;
  };
  // A term link opens the dialog itself rather than jumping to its hash, so a day or version deep link survives.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.term');
    if (a) {
      e.preventDefault();
      openHelp(a.hash.slice(4));
    }
  });
  $('info').addEventListener('click', () => openHelp());
  $('help-close').addEventListener('click', () => help.close());
  help.addEventListener('click', (e) => {
    if (e.target === help) help.close();
  });
  help.addEventListener('close', () => {
    if (/^#fn-/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  });
  $('hatch-term').replaceChildren(term('notyet', 'Not yet collected'));

  // ---- the You row: region and usage, remembered in this browser ----
  const stored = (() => {
    try {
      return JSON.parse(remembered(USAGE_KEY));
    } catch {
      return null;
    }
  })();
  const kwh = stored ? { electricity: stored.electricity, gas: stored.gas } : { ...tdcv };
  $('kwh-electricity').value = kwh.electricity ?? '';
  $('kwh-gas').value = kwh.gas ?? '';
  const showUsageHint = (edited) =>
    $('usage-hint').replaceChildren(
      ...(edited ? ['your usage'] : [term('tdcv', 'typical home (Ofgem)'), '; your bill shows your own kWh']),
    );
  showUsageHint(Boolean(stored));
  const fuels = () => (kwh.gas == null ? ['electricity'] : ['electricity', 'gas']);

  // region: the one selected; shown: the one whose lines are loaded (they differ while a fetch is in flight or failed)
  const state = { view: 'rates', window: '12', per: 'year', off: new Set(), region: null, shown: null, lines: null };
  const perMonth = () => state.view === 'annual' && state.per === 'month';
  const select = $('region');
  select.replaceChildren(
    ...Object.entries(meta.regions).map(([code, name]) => el('option', { value: code, textContent: name })),
  );

  // ---- the lines of one region: the cap first (drawn under the others), then each family in config order ----
  const lineSet = (region, files) => {
    const withDays = (file) => ({
      file,
      byDay: Object.fromEntries(['electricity', 'gas'].map((f) => [f, new Map(file[f].days.map((p) => [p.day, p]))])),
    });
    const [cap, ...fams] = files;
    return [
      {
        id: 'cap',
        label: `Ofgem price cap, ${regionName(region)}`,
        colour: 'var(--cap)',
        dash: [6, 4],
        ...withDays(cap),
      },
      ...meta.families.map((f, i) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        colour: pair(PALETTE[i]),
        versions: new Set(f.versions.map((v) => v.code)),
        ...withDays(fams[i]),
      })),
    ];
  };
  const rate = (line, fuel, field, day) => line.byDay[fuel].get(day)?.[field] ?? null;
  /** Estimated £ a year (or a month) on `day` for the fuels the viewer has; null if any of them has no rate. */
  const cost = (line, day) => {
    let total = 0;
    for (const fuel of fuels()) {
      const c = annualCost(line.byDay[fuel].get(day) ?? { unit: null, standingCharge: null }, kwh[fuel]);
      if (c == null) return null;
      total += c;
    }
    return perMonth() ? total / 12 : total;
  };
  const perLabel = () => (perMonth() ? '/month' : '/yr');

  // ---- the x range: the right edge is the end of the later of the data's last day and the viewer's today ----
  const range = (months = state.window) => {
    const lastDay = state.lines.reduce((m, l) => {
      const d = l.file.electricity.days.at(-1)?.day;
      return d && d > m ? d : m;
    }, '');
    const today = dayOf(Date.now());
    const edge = today > lastDay ? today : lastDay;
    const first = state.lines.reduce((m, l) => {
      const d = l.file.electricity.days[0]?.day;
      return d && d < m ? d : m;
    }, lastDay);
    const from = months === 'all' ? first : addMonths(addDays(edge, 1), -Number(months));
    const days = [];
    for (let d = from; d <= lastDay; d = addDays(d, 1)) days.push(d);
    return { from, to: addDays(edge, 1), lastDay, days };
  };
  let view = null; // the current range, shared by every chart and the plugins

  // ---- chart furniture: dashed verticals at cap changes, the not-yet-collected hatch ----
  const patterns = new Map();
  const pattern = (stroke) => {
    if (!patterns.has(stroke)) {
      const c = el('canvas', { width: 8, height: 8 });
      const g = c.getContext('2d');
      g.strokeStyle = stroke;
      g.beginPath();
      g.moveTo(0, 8);
      g.lineTo(8, 0);
      g.stroke();
      patterns.set(stroke, c);
    }
    return patterns.get(stroke);
  };
  const furniture = {
    id: 'furniture',
    beforeDatasetsDraw(chart) {
      if (!view) return; // the first paint, before any region has loaded
      const {
        ctx,
        chartArea: a,
        scales: { x },
      } = chart;
      ctx.save();
      const x0 = Math.max(a.left, x.getPixelForValue(ms(addDays(view.lastDay, 1))));
      const x1 = Math.min(a.right, x.getPixelForValue(ms(view.to)));
      chart.$hatch = { x0, x1, width: Math.max(0, x1 - x0) };
      if (x1 > x0) {
        ctx.fillStyle = ctx.createPattern(pattern(css('--hatch')), 'repeat');
        ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      }
      ctx.strokeStyle = css('--marker');
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      chart.$markers = [];
      for (const day of meta.capChanges) {
        const px = Math.round(x.getPixelForValue(ms(day))) + 0.5;
        if (px < a.left || px > a.right) continue;
        chart.$markers.push(day);
        ctx.beginPath();
        ctx.moveTo(px, a.top);
        ctx.lineTo(px, a.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  // x ticks on month starts, thinned to every k-th month so labels keep ~64px each at the panel's width.
  const monthTicks = (scale) => {
    const start = new Date(scale.min);
    let m = start.getUTCFullYear() * 12 + start.getUTCMonth() + (start.getUTCDate() > 1 ? 1 : 0);
    const months = [];
    for (; Date.UTC(Math.floor(m / 12), m % 12, 1) <= scale.max; m++) months.push(m);
    const fit = Math.max(2, Math.floor(scale.width / 64));
    const k = [1, 2, 3, 4, 6, 12, 24, 36, 60].find((n) => Math.ceil(months.length / n) <= fit) ?? 120;
    scale.$step = k;
    scale.ticks = months.filter((n) => n % k === 0).map((n) => ({ value: Date.UTC(Math.floor(n / 12), n % 12, 1) }));
  };
  const tickLabel = function (v) {
    const opts = this.$step >= 12 ? { year: 'numeric' } : { month: 'short', year: '2-digit' };
    return new Date(v).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
  };

  const tooltip = (fmt) => ({
    filter: (it) => it.parsed.y != null && !Number.isNaN(it.parsed.y),
    usePointStyle: true,
    backgroundColor: () => css('--tip-bg'),
    borderColor: () => css('--tip-line'),
    borderWidth: 1,
    cornerRadius: 8,
    padding: 10,
    titleColor: () => css('--text'),
    bodyColor: () => css('--text'),
    titleFont: { weight: '600' },
    callbacks: {
      title: (items) => (items.length ? fmtDate(view.days[Math.floor(items[0].dataIndex / 2)]) : ''),
      label: (it) => `${it.dataset.label} – ${fmt(it.parsed.y)}`,
      labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
      labelColor: (it) => ({ borderColor: it.dataset.borderColor, backgroundColor: it.dataset.borderColor }),
    },
  });
  const makeChart = (canvas, { top, fmt, tick }) =>
    // Chart is the vendored UMD global, loaded by index.html before this module
    new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top, right: 6 } },
        plugins: { legend: { display: false }, tooltip: tooltip(fmt) },
        scales: {
          x: {
            type: 'linear',
            grid: { display: false },
            border: { color: () => css('--axis') },
            afterBuildTicks: monthTicks,
            ticks: { autoSkip: false, maxRotation: 0, color: () => css('--tick'), callback: tickLabel },
          },
          y: {
            min: 0,
            grid: { color: () => css('--grid') },
            border: { display: false },
            ticks: { maxTicksLimit: top > 10 ? 5 : 7, color: () => css('--tick'), callback: tick },
          },
        },
      },
      plugins: [furniture],
    });

  // Two points per day, at its start and at the next day's start: each day's value is a flat step across the whole day,
  // a null day breaks the line over exactly that day, and the last day reaches the right edge.
  const series = (value) => {
    const data = [];
    for (const day of view.days) {
      const y = value(day);
      data.push({ x: ms(day), y }, { x: ms(day) + DAY, y });
    }
    return data;
  };
  const datasetsFor = (value) =>
    state.lines.map((line) => ({
      label: line.label,
      lineId: line.id,
      data: series((day) => value(line, day)),
      borderColor: css(line.colour),
      backgroundColor: css(line.colour),
      borderWidth: 2,
      borderDash: line.dash ?? [],
      borderJoinStyle: 'round',
      borderCapStyle: 'round',
      pointRadius: 0,
      pointHoverRadius: 0,
      pointStyle: 'line',
      spanGaps: false,
      order: line.id === 'cap' ? 1 : 0,
      hidden: state.off.has(line.id),
    }));

  const charts = {};
  for (const p of PANELS)
    charts[p.id] = makeChart($(`c-${p.id}`), {
      top: 30,
      fmt: pence,
      tick: (v) => (Number.isInteger(v) ? v : v.toFixed(1)),
    });
  charts.annual = makeChart($('c-annual'), {
    top: 8,
    fmt: (v) => `${pounds(v)}${perLabel()}`,
    tick: (v) => pounds(v),
  });
  window.__charts = charts; // test hook read by test/browser.spec.js

  // ---- drawing: every control and input calls draw(); everything is recomputed from the current state ----
  const chipText = (line) => {
    if (line.id === 'cap') {
      const c = cost(line, view.lastDay);
      return c == null ? 'next period not yet entered' : `about ${pounds(c)}${perLabel()}`;
    }
    const sold = ['electricity', 'gas'].some((f) => line.file[f].days.some((p) => p.unit != null));
    if (!sold) return null;
    const c = cost(line, view.lastDay);
    return c == null ? 'not on sale' : `about ${pounds(c)}${perLabel()}`;
  };
  const drawChips = () => {
    $('chips').replaceChildren(
      ...state.lines.map((line) => {
        const text = chipText(line);
        const disabled = text == null;
        const name = line.kind === 'variable' ? `${line.label} (variable)` : line.label;
        const b = el(
          'button',
          { type: 'button', className: 'chip', disabled, dataset: { line: line.id } },
          el('span', { className: `key${line.dash ? ' dash' : ''}`, style: `--c:${line.colour}` }),
          el('b', { textContent: name }),
          el('small', { textContent: disabled ? `not sold in ${regionName(state.shown)}` : text }),
        );
        b.setAttribute('aria-pressed', String(!disabled && !state.off.has(line.id)));
        if (!disabled)
          b.addEventListener('click', () => {
            if (state.off.has(line.id)) state.off.delete(line.id);
            else state.off.add(line.id);
            draw();
          });
        return b;
      }),
    );
  };
  const drawNote = () => {
    const tail = ['Dashed lines: ', term('cap', 'price cap'), ' changes; Flexible tracks the cap.'];
    $('note').replaceChildren(
      ...(state.view === 'rates'
        ? ['Rates ', term('vat', 'inc VAT'), ' ', term('signup', 'if you signed up that day'), '. ', ...tail]
        : [
            term('annual', `Estimated ${perMonth() ? 'monthly' : 'yearly'} cost`),
            ' at your usage, ',
            term('standing', 'standing charge'),
            ' included, ',
            term('signup', 'if you signed up that day'),
            '. Estimates, not bills. ',
            ...tail,
          ]),
    );
  };
  const drawTitles = () => {
    const noGas = kwh.gas == null;
    for (const p of PANELS) {
      const what = p.field === 'unit' ? term('unit', 'unit rate') : term('standing', 'standing charge');
      const fuel = p.fuel === 'gas' ? 'Gas' : 'Electricity';
      $(`t-${p.id}`).replaceChildren(
        `${fuel} `,
        what,
        ` ${p.unit}`,
        ...(p.fuel === 'gas' && noGas ? [' · no gas supply'] : []),
      );
    }
  };
  function draw() {
    if (!state.lines) return;
    view = range();
    for (const p of PANELS) {
      const c = charts[p.id];
      c.data.datasets = datasetsFor((line, day) => rate(line, p.fuel, p.field, day));
      Object.assign(c.options.scales.x, { min: ms(view.from), max: ms(view.to) });
      c.update('none');
    }
    const a = charts.annual;
    a.data.datasets = datasetsFor((line, day) => cost(line, day));
    Object.assign(a.options.scales.x, { min: ms(view.from), max: ms(view.to) });
    a.update('none');
    drawChips();
    drawNote();
    drawTitles();
    $('legend-hatch').hidden = !(view.to > addDays(view.lastDay, 1));
    drawFooter();
  }
  function drawFooter() {
    $('footer').textContent =
      `Data: Octopus Energy public API · ${regionName(state.shown)} · direct debit · prices inc VAT · updated ${fmtDate(meta.generatedAt.slice(0, 10))}.`;
  }

  const showView = () => {
    $('rates').hidden = !state.lines || state.view !== 'rates'; // no charts while the selected region has no data
    $('annual').hidden = !state.lines || state.view !== 'annual';
    $('per').hidden = state.view !== 'annual';
  };
  const segment = (id, onPick) =>
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of $(id).children) x.setAttribute('aria-pressed', String(x === b));
      onPick(b.dataset.v);
      draw();
    });
  const pressWindow = () => {
    for (const x of $('window').children) x.setAttribute('aria-pressed', String(x.dataset.v === state.window));
  };
  segment('window', (v) => {
    state.window = v;
  });
  segment('view', (v) => {
    state.view = v;
    showView();
  });
  segment('per', (v) => {
    state.per = v;
  });

  const onUsage = () => {
    const read = (input) => (input.value.trim() === '' ? null : Math.max(0, Number(input.value) || 0));
    kwh.electricity = read($('kwh-electricity')) ?? 0;
    kwh.gas = read($('kwh-gas'));
    remember(USAGE_KEY, JSON.stringify(kwh));
    showUsageHint(true);
    draw();
  };
  $('kwh-electricity').addEventListener('input', onUsage);
  $('kwh-gas').addEventListener('input', onUsage);

  // ---- deep links: #<productCode> opens that version's tooltip on its first day on sale; #YYYY-MM-DD opens the day's ----
  const openTooltip = (day, lineId) => {
    if (!state.lines) return;
    if (day < range().from) {
      const wide = WINDOWS.find((w) => range(w).from <= day);
      if (!wide) return; // before the first data day: no window holds it, so the page stays as it is
      state.window = wide;
      pressWindow();
      draw();
    }
    const i = view.days.indexOf(day);
    if (i < 0) return;
    const chart = state.view === 'rates' ? charts['electricity-unit'] : charts.annual;
    const active = chart.data.datasets
      .map((d, datasetIndex) => ({ d, datasetIndex }))
      .filter(({ d }) => (lineId ? d.lineId === lineId : true) && !d.hidden && d.data[2 * i].y != null)
      .map(({ datasetIndex }) => ({ datasetIndex, index: 2 * i }));
    if (!active.length) return;
    const pt = chart.getDatasetMeta(active[0].datasetIndex).data[2 * i];
    chart.tooltip.setActiveElements(active, { x: pt.x, y: pt.y });
    chart.setActiveElements(active);
    chart.update('none');
  };
  const fromHash = () => {
    let h;
    try {
      h = decodeURIComponent(location.hash.slice(1));
    } catch {
      return; // a malformed hash is no deep link
    }
    if (!h) return;
    const fn = /^fn-(\w+)$/.exec(h);
    if (fn) {
      if (DEFS[fn[1]]) openHelp(fn[1]);
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(h)) return openTooltip(h);
    const line = state.lines?.find((l) => l.versions?.has(h));
    if (!line) return;
    const first =
      line.file.electricity.days.find((p) => p.version === h) ?? line.file.gas.days.find((p) => p.version === h);
    if (first) openTooltip(first.day, line.id);
  };
  addEventListener('hashchange', fromHash);

  // ---- region: ?region= deep link, else remembered, else IP geolocation, else the configured default ----
  const load = async (region) => {
    state.region = region;
    select.value = region;
    let files;
    try {
      files = await Promise.all(
        ['cap', ...meta.families.map((f) => f.id)].map((id) => get(`./data/${region}/${id}.json`)),
      );
    } catch {
      if (state.region !== region) return; // superseded by a later pick
      state.lines = null;
      state.shown = region;
      $('load-error').textContent = `Could not load data for ${regionName(region)}`;
      $('load-error').hidden = false;
      $('chips').replaceChildren();
      $('legend-hatch').hidden = true;
      showView();
      drawFooter();
      return;
    }
    if (state.region !== region) return; // superseded by a later pick: its response decides
    state.lines = lineSet(region, files);
    state.shown = region;
    $('load-error').hidden = true;
    showView();
    draw();
  };
  const fromIp = async () => {
    try {
      const wait = { signal: AbortSignal.timeout(3000) }; // a slow lookup falls back rather than holding the page
      const ip = await get('https://ipinfo.io/json', wait);
      if (ip.country !== 'GB' || !ip.postal) return null;
      const gsp = await get(
        `https://api.octopus.energy/v1/industry/grid-supply-points/?postcode=${encodeURIComponent(ip.postal)}`,
        wait,
      );
      return gsp.results?.[0]?.group_id ?? null;
    } catch {
      return null;
    }
  };
  const known = (r) => (r && Object.hasOwn(meta.regions, r) ? r : null);
  const pick =
    known(new URLSearchParams(location.search).get('region')) ??
    known(remembered(REGION_KEY)) ??
    known(await fromIp()) ??
    meta.defaultRegion;
  select.addEventListener('change', async () => {
    remember(REGION_KEY, select.value);
    if (new URLSearchParams(location.search).has('region'))
      history.replaceState(null, '', location.pathname + location.hash);
    await load(select.value);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  await load(pick);
  fromHash();
  document.body.dataset.ready = 'true'; // tests wait for it
}

main().catch((e) => {
  console.error(e);
  $('load-error').textContent = 'Could not load data';
  $('load-error').hidden = false;
  $('rates').hidden = true;
});
