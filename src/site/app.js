import { annualAt, capSeries, costSince, MIN_START, versionSeries } from './lib/compare.js';
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
const MINE_KEY = 'octopus-tariffs:mine';
/** The comparison's reference version when the viewer has picked no tariff (PLAN.md section 1, Comparison). */
const REF_VERSION = 'OE-FIX-18M-26-09-11';
const HINT =
  "Estimates, not bills. Your usage follows a typical home's seasonal pattern; standing charge and VAT included; direct debit. Each tariff is costed at its own rates from the date, on sale then or not. Exit fees, service and brand ignored.";
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
    exitfee: [
      'Exit fee',
      'What a fixed tariff charges, per fuel, to leave before its fixed term ends. The comparison leaves exit fees out.',
    ],
    compare: [
      'Compare tariffs',
      'Each picked tariff is costed day by day from the date to the last day collected, at the rates it would have charged, at your usage: a fixed version\'s own rates, its first rate reaching back to days before it was on sale; a variable version, and the price cap, at their own rates, a variable version taking the Flexible version on sale before its launch. A tariff with no rate on some day of the span is listed without a total. "If today\'s rates stayed the same" is a full year at the latest rates collected.',
    ],
    profile: [
      'Seasonal pattern',
      'Your kWh a year is spread over the months as a typical home uses it. Electricity: Elexon Profile Class 1 half-hourly demand for April 2025 to March 2026 summed per month, from Ofgem\'s price cap "Supplementary workbook to annex 2, 3 and 4 – demand and losses" v1.19; one weather year. Gas: Xoserve\'s Annual Load Profile for gas year 2026-27, EUC E2601BND (domestic), summed per month and averaged over the 13 mainland LDZs.',
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
  // mine: the viewer's tariff {code, since} (since null = its launch), remembered; picked and from: the comparison
  const storedMine = (() => {
    try {
      const m = JSON.parse(remembered(MINE_KEY));
      return typeof m?.code === 'string' ? { code: m.code, since: m.since ?? null } : null;
    } catch {
      return null;
    }
  })();
  const state = {
    view: 'rates',
    window: '12',
    per: 'year',
    off: new Set(),
    region: null,
    shown: null,
    lines: null,
    mine: storedMine,
    picked: [],
    from: null,
  };
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
      // the solid "compare from" vertical on every chart, labelled only on the annual-cost chart
      ctx.save();
      const fx = Math.round(x.getPixelForValue(ms(state.from ?? '0000-01-01'))) + 0.5;
      const shown = state.from != null && fx >= a.left && fx <= a.right;
      chart.$compareFrom = shown ? state.from : null;
      chart.$compareLabel = shown && chart === charts.annual;
      if (shown) {
        ctx.strokeStyle = css('--text-2');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fx, a.top);
        ctx.lineTo(fx, a.bottom);
        ctx.stroke();
        if (chart.$compareLabel) {
          ctx.fillStyle = css('--text-2');
          ctx.font = '11px system-ui, sans-serif';
          ctx.textBaseline = 'bottom'; // in the top padding, above the plot, so it never sits on a line
          const w = ctx.measureText('compare from').width;
          ctx.fillText('compare from', fx + 4 + w > a.right ? fx - 4 - w : fx + 4, a.top - 2);
        }
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
        onClick: (e, _active, chart) => pickLine(e, chart),
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
            ticks: { maxTicksLimit: top > 25 ? 5 : 7, color: () => css('--tick'), callback: tick },
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
    top: 20, // room for the "compare from" label above the plot
    fmt: (v) => `${pounds(v)}${perLabel()}`,
    tick: (v) => pounds(v),
  });
  window.__charts = charts; // test hook read by test/browser.spec.js

  // ---- my tariff and the comparison (PLAN.md section 1, You row and Comparison) ----
  const versionInfo = new Map(); // code -> {family, version, colour}
  meta.families.forEach((f, i) => {
    for (const v of f.versions) versionInfo.set(v.code, { family: f, version: v, colour: pair(PALETTE[i]) });
  });
  const cutoff = () => view.lastDay; // generatedAt's day: comparisons run up to it, never past it
  const yesterday = () => addDays(cutoff(), -1);
  const clampDay = (d) => (d < MIN_START ? MIN_START : d > yesterday() ? yesterday() : d);
  const launchOf = (code) => versionInfo.get(code).version.availableFrom;
  const lineOf = (code) => state.lines.find((l) => l.id === versionInfo.get(code).family.id);
  /** The versions offered in the region, per family, newest first: those with rates since 2023-07-01 (build emits them). */
  const offered = (f) =>
    Object.keys(state.lines.find((l) => l.id === f.id)?.file.electricity.versions ?? {}).sort((a, b) =>
      launchOf(b).localeCompare(launchOf(a)),
    );
  const isOffered = (code) => versionInfo.has(code) && offered(versionInfo.get(code).family).includes(code);
  const mineCode = () => (state.mine && isOffered(state.mine.code) ? state.mine.code : null);
  const saveMine = () => remember(MINE_KEY, JSON.stringify(state.mine));
  /** The earliest since-date of a version: its launch, or the earliest comparison start if it launched before. */
  const firstSince = (code) => (launchOf(code) > MIN_START ? launchOf(code) : MIN_START);
  const mineSince = () => {
    const first = firstSince(mineCode());
    return clampDay(state.mine.since && state.mine.since >= first ? state.mine.since : first);
  };
  /** Side A when the viewer has no tariff: the reference version if sold here, else the latest launched version. */
  /** The reference version, skipping `skip`: OE-FIX-18M-26-09-11 if sold here, else the latest launched version. */
  const refCode = (skip = []) =>
    isOffered(REF_VERSION) && !skip.includes(REF_VERSION)
      ? REF_VERSION
      : (meta.families
          .flatMap(offered)
          .filter((c) => !skip.includes(c))
          .sort((a, b) => launchOf(b).localeCompare(launchOf(a)))
          .at(0) ?? null);
  /** Picks that would be fewer than two (my tariff is the Flexible version itself) take the reference as the second. */
  const atLeastTwo = (picks) => (picks.length < 2 ? [...picks, refCode(picks)].filter(Boolean) : picks);
  const flexCode = () => {
    const f = meta.families.find((x) => x.kind === 'variable');
    return f ? (offered(f)[0] ?? null) : null;
  };
  const resetComparison = () => {
    const a = mineCode() ?? refCode();
    state.picked = atLeastTwo([...new Set([a, flexCode()].filter(Boolean))]);
    state.from = mineCode() ? mineSince() : a ? clampDay(launchOf(a)) : yesterday();
  };
  const typeOf = (key) => {
    if (key === 'cap') return 'cap level';
    const { family, version } = versionInfo.get(key);
    return family.kind === 'fixed' ? `fixed ${version.term}M` : 'variable';
  };
  const shortName = (key) => {
    if (key === 'cap') return 'Ofgem price cap';
    const { family, version } = versionInfo.get(key);
    const name = version.fullName.replace(/^Octopus /, '');
    return family.kind === 'fixed' ? name.replace(' Fixed ', ' ') : name;
  };
  const named = (key) => `${shortName(key)} (${typeOf(key)})`;
  const colourOf = (key) => (key === 'cap' ? 'var(--cap)' : versionInfo.get(key).colour);
  /** The comparison series of one tariff for one fuel, or null when it has no rates for that fuel in the region. */
  const seriesFor = (key, fuel) => {
    if (key === 'cap') return capSeries(state.lines.find((l) => l.id === 'cap').file[fuel]);
    const file = lineOf(key).file[fuel];
    return file.versions[key] ? versionSeries(versionInfo.get(key).family.kind, file, key) : null;
  };
  /** Cost from state.from to the cutoff over the viewer's fuels: {cost, days, unpriced (sorted days)}. */
  const costOf = (key) => {
    let cost = 0;
    let days = 0;
    const unpriced = new Set();
    for (const fuel of fuels()) {
      const series = seriesFor(key, fuel);
      const r = costSince(series ?? capSeries({ days: [] }), state.from, cutoff(), fuel, kwh[fuel]); // none: no rates at all
      cost += r.cost;
      days = r.days;
      for (const d of r.unpriced) unpriced.add(d);
    }
    return { key, cost, days, unpriced: [...unpriced].sort() };
  };
  /** £ a year at the latest rates collected, over the viewer's fuels; null when any has no rate that day. */
  const annualNow = (key) => {
    let total = 0;
    for (const fuel of fuels()) {
      const series = seriesFor(key, fuel);
      const a = series ? annualAt(series, cutoff(), kwh[fuel]) : null;
      if (a == null) return null;
      total += a;
    }
    return total;
  };
  /** Where a tariff's unpriced days sit in the span: at the start, at the end, one gap inside, or several gaps. */
  const unpricedText = ({ unpriced }) => {
    const runs = [];
    for (const d of unpriced) {
      if (runs.length && addDays(runs.at(-1)[1], 1) === d) runs.at(-1)[1] = d;
      else runs.push([d, d]);
    }
    if (runs.length > 1) return 'no rates on some days';
    const [[a, b]] = runs;
    const atStart = a === state.from;
    const atEnd = b === addDays(cutoff(), -1);
    if (atStart && atEnd) return 'no rates in this span';
    if (atStart) return `no rates before ${fmtDate(addDays(b, 1))}`;
    if (atEnd) return `no rates after ${fmtDate(addDays(a, -1))}`;
    return `no rates ${fmtDate(a)} – ${fmtDate(b)}`;
  };
  const setFrom = (day) => {
    state.from = clampDay(day);
    draw();
  };
  /** A click within HIT px of a family line, above or below its step on the clicked day, sets the date to that version's launch. */
  const HIT = 8;
  const pickLine = (e, chart) => {
    if (!state.lines) return;
    const i = view.days.indexOf(dayOf(Math.floor(chart.scales.x.getValueForPixel(e.x) / DAY) * DAY));
    if (i < 0) return;
    let near = null;
    chart.data.datasets.forEach((ds, k) => {
      const y = ds.data[2 * i].y;
      if (ds.lineId === 'cap' || y == null || !chart.isDatasetVisible(k)) return;
      const d = Math.abs(chart.scales.y.getPixelForValue(y) - e.y);
      if (d <= HIT && (!near || d < near.d)) near = { d, id: ds.lineId };
    });
    if (!near) return;
    const line = state.lines.find((l) => l.id === near.id);
    const code = line.byDay.electricity.get(view.days[i])?.version ?? line.byDay.gas.get(view.days[i])?.version;
    if (code) setFrom(launchOf(code));
  };
  const optgroups = (skip) =>
    meta.families
      .map((f) => {
        const codes = offered(f).filter((c) => !skip.includes(c));
        return codes.length
          ? el(
              'optgroup',
              { label: f.label },
              ...codes.map((c) => el('option', { value: c, textContent: shortName(c) })),
            )
          : null;
      })
      .filter(Boolean);
  const drawMine = () => {
    const code = mineCode();
    $('mine').replaceChildren(el('option', { value: '', textContent: 'none' }), ...optgroups([]));
    $('mine').value = code ?? '';
    const since = $('since');
    since.disabled = !code;
    const line = $('mine-line');
    line.hidden = !code;
    if (!code) {
      since.value = '';
      return;
    }
    Object.assign(since, { min: firstSince(code), max: yesterday(), value: mineSince() });
    const { family, version } = versionInfo.get(code);
    const a = annualNow(code);
    const about = a == null ? [] : [` · about ${pounds(a)}/yr`];
    if (family.kind === 'fixed') {
      const fee = fuels().reduce((sum, f) => sum + (lineOf(code).file[f].versions[code]?.exitFee ?? 0), 0);
      line.replaceChildren(
        term('fixed', 'Fixed'),
        ` until ${fmtDate(addMonths(mineSince(), version.term))}`,
        ...about,
        ` · ${pounds(fee)} `,
        term('exitfee', 'to leave early'),
        '.',
      );
    } else line.replaceChildren(term('variable', 'Variable'), ...about, ' · no ', term('exitfee', 'exit fee'), '.');
  };
  const drawCompare = () => {
    $('picked').replaceChildren(
      ...state.picked.map((key) => {
        const b = el(
          'button',
          { type: 'button', className: 'chip', dataset: { key }, ariaLabel: `Remove ${shortName(key)}` },
          el('span', { className: `key${key === 'cap' ? ' dash' : ''}`, style: `--c:${colourOf(key)}` }),
          shortName(key),
          el('span', { className: 'x', textContent: '×', ariaHidden: 'true' }),
        );
        b.addEventListener('click', () => {
          state.picked = state.picked.filter((k) => k !== key);
          draw();
        });
        return b;
      }),
    );
    $('add').replaceChildren(
      el('option', { value: '', textContent: 'Add a tariff…' }),
      ...(state.picked.includes('cap') ? [] : [el('option', { value: 'cap', textContent: 'Ofgem price cap' })]),
      ...optgroups(state.picked),
    );
    Object.assign($('from'), { min: MIN_START, max: yesterday(), value: state.from });
    if (state.picked.length < 2) {
      $('lead').textContent = 'Add at least two tariffs.';
      $('bars').replaceChildren();
      $('forward').textContent = '';
      return;
    }
    const rows = state.picked.map(costOf);
    const ranked = rows.filter((r) => !r.unpriced.length).sort((a, b) => a.cost - b.cost);
    const unranked = rows.filter((r) => r.unpriced.length);
    const today = dayOf(Date.now()) <= cutoff() ? 'today' : fmtDate(cutoff());
    $('lead').replaceChildren(
      'From ',
      el('b', { textContent: fmtDate(state.from) }),
      ` to ${today} (${rows[0].days} ${rows[0].days === 1 ? 'day' : 'days'}), `,
      term('compare', 'cheapest first'),
      ':',
    );
    const top = Math.max(...ranked.map((r) => r.cost), 0);
    const label = (key) =>
      el(
        'span',
        { className: 'name' },
        `${shortName(key)} `,
        el('span', { className: 'type', textContent: `(${typeOf(key)})` }),
        ...(key === mineCode() ? [' ', el('span', { className: 'you-tag', textContent: 'you' })] : []),
      );
    $('bars').replaceChildren(
      ...ranked.flatMap((r) => {
        const d = Math.round(r.cost - ranked[0].cost);
        return [
          label(r.key),
          el('span', {
            className: 'bar',
            style: `--c:${colourOf(r.key)};width:${top ? (r.cost / top) * 100 : 0}%`,
            dataset: { key: r.key },
          }),
          el(
            'span',
            { className: 'total', dataset: { key: r.key } },
            el('b', { textContent: `about ${pounds(r.cost)}` }),
            ...(d >= 1 ? [' ', el('span', { className: 'delta', textContent: `+${pounds(d)}` })] : []),
          ),
        ];
      }),
      ...unranked.flatMap((r) => [
        label(r.key),
        el('span', { className: 'unranked', textContent: unpricedText(r), dataset: { key: r.key } }),
      ]),
    );
    $('forward').textContent = `If today's rates stayed the same: ${state.picked
      .map((key) => {
        const a = annualNow(key);
        return a == null ? `${named(key)} no rates today` : `${named(key)} about ${pounds(a)}/yr`;
      })
      .join(' · ')}. A variable tariff's rates move with the price cap.`;
  };

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
    drawMine();
    drawCompare();
    $('legend-hatch').hidden = !(view.to > addDays(view.lastDay, 1));
    drawFooter();
  }
  function drawFooter() {
    $('footer').textContent =
      `Data: Octopus Energy public API · ${regionName(state.shown)} · direct debit · prices inc VAT · updated ${fmtDate(meta.generatedAt.slice(0, 10))}.`;
    const files = state.lines ? state.lines.filter((l) => l.id !== 'cap') : [];
    $('csv').replaceChildren(
      ...(files.length ? ['Daily rates as CSV: '] : []),
      ...files.flatMap((l, i) => [
        ...(i ? [' · '] : []),
        el('a', { href: `./data/${state.shown}/${l.id}.csv`, download: '', textContent: l.label }),
      ]),
    );
  }

  const showView = () => {
    $('rates').hidden = !state.lines || state.view !== 'rates'; // no charts while the selected region has no data
    $('annual').hidden = !state.lines || state.view !== 'annual';
    $('compare').hidden = !state.lines;
    // the tariff and comparison controls read the region's lines: off, and the summary line hidden, without them
    for (const id of ['mine', 'add', 'from']) $(id).disabled = !state.lines;
    if (!state.lines) {
      $('since').disabled = true;
      $('mine-line').hidden = true;
    }
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

  // Choosing my tariff makes it side A, in place of the previous one, and starts the comparison at its since-date.
  $('mine').addEventListener('change', () => {
    if (!state.lines) return;
    const code = $('mine').value || null;
    const before = mineCode() ?? refCode();
    state.mine = code ? { code, since: null } : null;
    saveMine();
    const a = code ?? refCode();
    state.picked = atLeastTwo([a, ...state.picked.filter((k) => k !== a && k !== before)].filter(Boolean));
    if (a) state.from = code ? mineSince() : clampDay(launchOf(a));
    draw();
  });
  $('since').addEventListener('change', () => {
    if (!state.lines) return;
    if (!mineCode()) return;
    state.mine.since = $('since').value || null;
    saveMine();
    state.from = mineSince();
    draw();
  });
  $('add').addEventListener('change', () => {
    if (!state.lines) return;
    const key = $('add').value;
    if (key && !state.picked.includes(key)) state.picked.push(key);
    draw();
  });
  $('from').addEventListener('change', () => {
    if (!state.lines) return;
    if ($('from').value) setFrom($('from').value);
  });
  const [hintHead, hintTail] = HINT.split("typical home's seasonal pattern");
  $('compare-hint').replaceChildren(hintHead, term('profile', "typical home's seasonal pattern"), hintTail);

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
    view = range();
    resetComparison();
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
