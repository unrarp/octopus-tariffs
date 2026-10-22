import { annualAt, capSeries, dailyCosts, MIN_START, versionSeries } from './lib/compare.js';
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
    unit: ['Unit rate', 'Pence per kWh used, VAT included.'],
    standing: ['Standing charge', 'Pence per day for being connected, VAT included, whatever you use.'],
    vat: ['Prices inc VAT', "VAT at the rate in force on each day, applied to Octopus's prices before VAT."],
    signup: [
      'If you signed up that day',
      'Each line shows the rates a new customer got that day. A fixed tariff keeps the rates of the day you signed up for its term.',
    ],
    onsale: [
      'On sale',
      'A version is on sale from its launch until the next version launches or Octopus withdraws it. A gap: nothing on sale in your region. "Not on sale": none today. "Not sold in": never sold in that region.',
    ],
    fixed: [
      'Fixed term',
      '18M, 12M or 6M Winter Fix: unit rates and standing charges held for 18, 12 or 6 months from sign-up, with an exit fee to leave early. Rates still step when a levy or VAT change passes through.',
    ],
    variable: ['Variable', 'Flexible Octopus: no term, no exit fee; rates move, usually with the price cap.'],
    annual: [
      'Estimated annual cost',
      "A full year at that day's rates: unit rate × your kWh + standing charge × 365, per fuel, added up. Per month divides by 12. An empty gas field leaves gas out. An estimate, not a bill.",
    ],
    tdcv: [
      'Typical Domestic Consumption Values (TDCV)',
      `Ofgem's typical home, revised 1 July 2026: ${tdcv.electricity.toLocaleString('en-GB')} kWh of electricity and ${tdcv.gas.toLocaleString('en-GB')} kWh of gas a year ("Summary of changes to energy price cap 1 July to 30 September 2026, revised TDCV"). Your bill shows your own kWh. Leave gas empty if you have none.`,
    ],
    cap: [
      'Price cap',
      "Ofgem's cap on standard variable tariffs: the most a supplier may charge per kWh and per day, set per region each quarter. A limit on rates, not a tariff or an average bill. Entered by hand from Ofgem's published levels; the grey dashed line stops at the last period entered.",
    ],
    exitfee: [
      'Exit fee',
      'Charged per fuel to leave a fixed tariff before its term ends; none in its last 49 days (Ofgem). Counted only in "if I switch".',
    ],
    compare: [
      'Compare tariffs',
      'Running cost from the date at each tariff\'s own rates and your usage. A fixed version holds its rates for its term (from your since-date for yours, from the date for others), then rolls on to Flexible; a variable version and the cap use their own rates. Solid: to the last day collected. Dashed: 12 more months at the latest rates, as if they stayed. "vs yours": the difference from your tariff, or Flexible if you have no fixed contract. No line for a tariff missing a rate on any day so far. Estimates, not bills: a typical seasonal pattern, standing charge and VAT included, direct debit; exit fees count only in "if I switch".',
    ],
    switch: [
      'If I switch',
      "From the switch date, each line is the exit fee (if any) plus what the tariff would cost you against staying put, at today's rates, a fixed tariff for its term from that day and Flexible after. Below £0 it has paid back. Ofgem bans exit fees in the last 49 days of a fixed term.",
    ],
    profile: [
      'Seasonal pattern',
      'Your kWh a year spread over the months like a typical home. Electricity: Elexon Profile Class 1 half-hourly demand, April 2025 to March 2026, summed per month (Ofgem price cap "Supplementary workbook to annex 2, 3 and 4 – demand and losses" v1.19); one weather year. Gas: Xoserve Annual Load Profile, gas year 2026-27, EUC E2601BND (domestic), summed per month, averaged over the 13 mainland LDZs.',
    ],
    region: [
      'Region',
      'Prices differ across the 14 electricity regions. The first visit guesses yours from your IP address; your pick is remembered in this browser.',
    ],
    data: [
      'Data',
      "Octopus Energy's public API: every version of each tariff with its full rate history, direct debit, collected daily. Price cap levels entered by hand from Ofgem's announcements.",
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
  $('cap-term').replaceChildren(term('cap', 'price cap change'));

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
    cmode: 'paid', // the comparison chart: £ paid, vs yours, or if I switch
    switchOn: null, // the day "if I switch" switches: in [cutoff, compareEnd()), the cutoff on region load
    focus: null, // the line whose chip is hovered: drawn over the others, faded
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
  /** Estimated £ a year (or a month) from the rows `rowOf(fuel)` for the fuels the viewer has; null if any has no rate. */
  const costOfRows = (rowOf) => {
    let total = 0;
    for (const fuel of fuels()) {
      const c = annualCost(rowOf(fuel) ?? { unit: null, standingCharge: null }, kwh[fuel]);
      if (c == null) return null;
      total += c;
    }
    return perMonth() ? total / 12 : total;
  };
  const cost = (line, day) => costOfRows((fuel) => line.byDay[fuel].get(day));
  const perLabel = () => (perMonth() ? '/month' : '/yr');

  // ---- the x range: the right edge is the end of the data's last day ----
  const range = (months = state.window) => {
    const lastDay = state.lines.reduce((m, l) => {
      const d = l.file.electricity.days.at(-1)?.day;
      return d && d > m ? d : m;
    }, '');
    const first = state.lines.reduce((m, l) => {
      const d = l.file.electricity.days[0]?.day;
      return d && d < m ? d : m;
    }, lastDay);
    const to = addDays(lastDay, 1);
    const from = months === 'all' ? first : addMonths(to, -Number(months));
    const days = [];
    for (let d = from; d <= lastDay; d = addDays(d, 1)) days.push(d);
    return { from, to, lastDay, days };
  };
  let view = null; // the current range, shared by every chart and the plugins

  // ---- chart furniture: dashed verticals at cap changes, the compare-from line, the hovered day's crosshair ----
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
      // a 1px vertical through the centre of the day the tooltip shows
      const tipped = chart.tooltip?.getActiveElements() ?? [];
      const day = tipped.length ? view.days[Math.floor(tipped[0].index / 2)] : null;
      if (day) {
        const cx = Math.round(x.getPixelForValue(ms(day) + DAY / 2)) + 0.5;
        ctx.strokeStyle = css('--text-2');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, a.top);
        ctx.lineTo(cx, a.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
  /** The elements of every visible line with a value on the i-th day, as a tooltip lists them. */
  const dayElements = (chart, i) =>
    chart.data.datasets
      .map((d, datasetIndex) => ({ d, datasetIndex }))
      .filter(({ d }) => !d.hidden && d.data[2 * i]?.y != null)
      .map(({ datasetIndex }) => ({ datasetIndex, index: 2 * i }));
  // Hovering a day on one rates panel shows that day's tooltip on all four. Only a real pointer event on the panel
  // under the pointer propagates (never a replay or the updates it makes itself); the day is the one its tooltip shows.
  let linking = false;
  let panels = null; // the four rate charts, once made
  const linked = {
    id: 'linked',
    afterEvent(chart, { event, replay }) {
      if (linking || replay || !event.native || (event.type !== 'mousemove' && event.type !== 'mouseout')) return;
      panels ??= PANELS.map((p) => charts[p.id]);
      if (!panels.includes(chart)) return;
      const shown = chart.tooltip.getActiveElements();
      const i = event.type === 'mouseout' || !shown.length ? -1 : Math.floor(shown[0].index / 2);
      linking = true;
      try {
        for (const c of panels) {
          if (c === chart) continue;
          const active = i < 0 ? [] : dayElements(c, i);
          const now = c.tooltip.getActiveElements();
          if (
            now.length === active.length &&
            now.every((e, n) => e.datasetIndex === active[n].datasetIndex && e.index === active[n].index)
          )
            continue;
          const at =
            i < 0
              ? { x: 0, y: 0 }
              : { x: c.scales.x.getPixelForValue(ms(view.days[i]) + DAY / 2), y: c.chartArea.top + 8 };
          c.tooltip.setActiveElements(active, at);
          c.setActiveElements(active);
          c.update('none');
        }
      } finally {
        linking = false;
      }
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

  /** The tooltip name of a line on the i-th day: the cap, a family and the version on sale that day, or mine; null
   *  for a family day with no version. */
  const tipName = (ds, i) => {
    if (ds.lineId === 'cap') return 'Ofgem price cap';
    if (ds.lineId === 'mine') return `You · ${shortName(mineCode())}`;
    const line = state.lines.find((l) => l.id === ds.lineId);
    const code = line.byDay.electricity.get(view.days[i])?.version ?? line.byDay.gas.get(view.days[i])?.version;
    return code ? shortName(code) : null; // the version name carries the family: "12M October 2026 v6"
  };
  const tooltip = (fmt) => ({
    filter: (it) =>
      it.parsed.y != null && !Number.isNaN(it.parsed.y) && tipName(it.dataset, Math.floor(it.dataIndex / 2)) != null,
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
      label: (it) => `${tipName(it.dataset, Math.floor(it.dataIndex / 2))} · ${fmt(it.parsed.y)}`,
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
            // Every y axis starts at zero by the owner's choice: an axis fitted to the data was tried and read as
            // "random starting values" that made the panels hard to compare (test: "every y axis starts at zero").
            min: 0,
            grid: { color: () => css('--grid') },
            border: { display: false },
            ticks: { maxTicksLimit: top > 25 ? 5 : 7, color: () => css('--tick'), callback: tick },
          },
        },
      },
      plugins: [furniture, linked],
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
  // While a chip is hovered its line is drawn a pixel wider and every other line at 30% of its colour.
  const fade = (colour) => colour.replace(/^rgb\((.*)\)$/, 'rgba($1, 0.3)');
  const emphasised = (ds) => {
    const focus = state.focus && !state.off.has(state.focus) ? state.focus : null;
    ds.borderColor = focus && ds.lineId !== focus ? fade(ds.baseColour) : ds.baseColour;
    ds.borderWidth = ds.baseWidth + (focus && ds.lineId === focus ? 1 : 0);
    return ds;
  };
  const emphasise = (lineId) => {
    state.focus = lineId;
    for (const [id, c] of Object.entries(charts)) {
      if (id === 'compare') continue; // its lines are tariffs, not the chips' families
      c.data.datasets.forEach(emphasised);
      c.update('none');
    }
  };
  const dataset = (props) => ({
    borderWidth: 2,
    borderDash: [],
    borderJoinStyle: 'round',
    borderCapStyle: 'round',
    pointRadius: 0,
    pointHoverRadius: 0,
    pointStyle: 'line',
    spanGaps: false,
    order: 0,
    hidden: false,
    ...props,
  });
  /** One dataset per line, then the line of my tariff on top when I have picked one; each chip hides its line. */
  const datasetsFor = (value, mineValue) =>
    [
      ...state.lines.map((line) =>
        dataset({
          label: line.label,
          lineId: line.id,
          data: series((day) => value(line, day)),
          borderColor: css(line.colour),
          backgroundColor: css(line.colour),
          borderDash: line.dash ?? [],
          order: line.id === 'cap' ? 1 : 0,
          hidden: state.off.has(line.id),
        }),
      ),
      ...(mineCode()
        ? [
            dataset({
              label: `You: ${shortName(mineCode())}`,
              lineId: 'mine',
              data: series(mineValue),
              borderColor: css('--text'),
              backgroundColor: css('--text'),
              borderWidth: 3,
              order: -1,
              hidden: state.off.has('mine'),
            }),
          ]
        : []),
    ].map((ds) => emphasised({ ...ds, baseColour: ds.borderColor, baseWidth: ds.borderWidth }));

  const charts = {};
  for (const p of PANELS)
    charts[p.id] = makeChart($(`c-${p.id}`), {
      top: 30,
      fmt: (v) => `${pence(v)} ${p.unit}`,
      tick: (v) => (Number.isInteger(v) ? v : v.toFixed(1)),
    });
  charts.annual = makeChart($('c-annual'), {
    top: 20, // room for the "compare from" label above the plot
    fmt: (v) => `${pounds(v)}${perLabel()}`,
    tick: (v) => pounds(v),
  });
  // The comparison chart: its own furniture (the "today" vertical, the zero line in vs yours), its own tooltip, no click.
  const compareFurniture = {
    id: 'compareFurniture',
    beforeDatasetsDraw(chart) {
      if (!view || state.from == null) return;
      const {
        ctx,
        chartArea: a,
        scales: { x, y },
      } = chart;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = css('--text-2');
      ctx.fillStyle = css('--text-2');
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'bottom'; // in the top padding, above the plot, as "compare from" is
      ctx.setLineDash([4, 4]);
      const vertical = (day, label) => {
        const vx = Math.round(x.getPixelForValue(ms(day))) + 0.5;
        ctx.beginPath();
        ctx.moveTo(vx, a.top);
        ctx.lineTo(vx, a.bottom);
        ctx.stroke();
        const w = ctx.measureText(label).width;
        ctx.fillText(label, vx + 4 + w > a.right ? vx - 4 - w : vx + 4, a.top - 2);
      };
      vertical(cutoff(), 'today');
      chart.$switchAt = state.cmode === 'switch' && state.switchOn > cutoff() ? state.switchOn : null;
      if (chart.$switchAt) vertical(chart.$switchAt, 'switch');
      if (state.cmode !== 'paid') {
        const zy = Math.round(y.getPixelForValue(0)) + 0.5;
        ctx.setLineDash([]);
        ctx.strokeStyle = css('--text');
        ctx.beginPath();
        ctx.moveTo(a.left, zy);
        ctx.lineTo(a.right, zy);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
  /** "+£n" or "−£n" for a difference in £. */
  const plusMinus = (v) => `${v < 0 ? '−' : '+'}${pounds(Math.abs(v))}`;
  const compareTip = tooltip(pounds);
  charts.compare = new Chart($('c-compare'), {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 20, right: 6 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...compareTip,
          // the point at the cutoff ends the solid line and starts the dashed one: listed once, as the solid one's
          filter: (it) => it.parsed.y != null && !(it.dataset.part === 'future' && it.dataIndex === it.dataset.cut),
          callbacks: {
            ...compareTip.callbacks,
            title: (items) => {
              if (!items.length) return '';
              const start = state.cmode === 'switch' ? state.switchOn : state.from;
              return fmtDate(addDays(start, Math.max(items[0].dataIndex - 1, 0)));
            },
            label: (it) => {
              const key = it.dataset.lineId;
              if (state.cmode === 'switch')
                return `${shortName(key)} · ${key === anchor() ? 'you' : plusMinus(it.parsed.y)}`;
              const v = state.cmode !== 'vs' ? pounds(it.parsed.y) : key === anchor() ? 'you' : plusMinus(it.parsed.y);
              return `${shortName(key)} · ${v}${it.dataset.part === 'future' ? " (at today's rates)" : ''}`;
            },
          },
        },
      },
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
          ticks: {
            maxTicksLimit: 7,
            color: () => css('--tick'),
            callback: (v) => (state.cmode !== 'paid' ? (v ? plusMinus(v) : '£0') : pounds(v)),
          },
        },
      },
    },
    plugins: [compareFurniture],
  });
  window.__charts = charts; // test hook read by test/browser.spec.js

  // ---- my tariff and the comparison ----
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
  const flexFamily = () => meta.families.find((x) => x.kind === 'variable');
  /** The Flexible version on sale now: the newest one offered in the region. */
  const flexCode = () => {
    const f = flexFamily();
    return f ? (offered(f)[0] ?? null) : null;
  };
  /** The exclusive end of my fixed term, or null for a variable tariff or none. */
  const termEnd = () => {
    const code = mineCode();
    if (!code) return null;
    const { family, version } = versionInfo.get(code);
    return family.kind === 'fixed' ? addMonths(mineSince(), version.term) : null;
  };
  const mineEnded = () => termEnd() != null && termEnd() <= cutoff();
  /** The comparison over a span is anchored on my tariff, else on the Flexible version on sale now. */
  const anchor = () => mineCode() ?? flexCode();
  /** My tariff and Flexible; when that is one tariff, the newest launched version as the second. */
  const resetComparison = () => {
    const a = anchor();
    const picks = [...new Set([a, flexCode()].filter(Boolean))];
    if (picks.length < 2) {
      const newest = meta.families
        .flatMap(offered)
        .filter((c) => c !== a)
        .sort((x, y) => launchOf(y).localeCompare(launchOf(x)))
        .at(0);
      if (newest) picks.push(newest);
    }
    state.picked = picks;
    state.from = mineCode() ? mineSince() : yesterday();
  };
  /** The row my tariff charges on `day` for `fuel`, or null outside my term (a variable one: since-date to cutoff). */
  const mineRow = (fuel, day) => {
    const code = mineCode();
    if (day < mineSince()) return null;
    const { family } = versionInfo.get(code);
    const line = lineOf(code);
    if (family.kind !== 'fixed') return day <= cutoff() ? (line.byDay[fuel].get(day) ?? null) : null;
    if (day >= termEnd()) return null;
    const own = line.file[fuel].versions[code]?.days ?? [];
    return own.find((p) => p.day === day) ?? own.at(-1) ?? null; // a fix signed after launch keeps its last rate
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
  const colourOf = (key) => (key === 'cap' ? 'var(--cap)' : versionInfo.get(key).colour);
  /** The comparison series of one tariff for one fuel, or null when it has no rates for that fuel in the region. */
  const seriesFor = (key, fuel) => {
    if (key === 'cap') return capSeries(state.lines.find((l) => l.id === 'cap').file[fuel]);
    const file = lineOf(key).file[fuel];
    return file.versions[key] ? versionSeries(versionInfo.get(key).family.kind, file, key) : null;
  };
  /** The comparison runs from the date to 12 months after the cutoff (exclusive): the cutoff's year at today's rates. */
  const compareEnd = () => addMonths(cutoff(), 12);
  /** The exclusive end of a fixed pick's term: from my since-date for my tariff, else from the date; else null. */
  const termOf = (key) => {
    if (key === 'cap') return null;
    const { family, version } = versionInfo.get(key);
    return family.kind === 'fixed' ? addMonths(key === mineCode() ? mineSince() : state.from, version.term) : null;
  };
  /**
   * The £ of each day in [from, end) over the viewer's fuels: `key`'s own rates until `split`, then the Flexible version
   * on sale now; null on a day any fuel has no rate. Days after the cutoff are priced at the cutoff's rates.
   */
  const dailyOver = (key, from, split, end) => {
    const part = (code, fuel, a, b) => {
      const series = code ? seriesFor(code, fuel) : null;
      return series
        ? dailyCosts(series, a, b, fuel, kwh[fuel], cutoff())
        : Array(Math.max(0, Math.round((ms(b) - ms(a)) / DAY))).fill(null);
    };
    let daily = null;
    for (const fuel of fuels()) {
      const days = [...part(key, fuel, from, split), ...part(flexCode(), fuel, split, end)];
      daily = daily ? daily.map((c, i) => (c == null || days[i] == null ? null : c + days[i])) : days;
    }
    return daily;
  };
  /** The exit fee of a version over the viewer's fuels: per fuel, as Octopus lists it. */
  const feeOf = (code) => fuels().reduce((sum, f) => sum + (lineOf(code).file[f].versions[code]?.exitFee ?? 0), 0);
  /** The last day "if I switch" can switch on: the day before the comparison's end. */
  const lastSwitch = () => addDays(compareEnd(), -1);
  /** The fee to leave my tariff on `day`: none for a variable one, an ended term, or its last 49 days (Ofgem's rule). */
  const exitFeeOn = (day) => {
    const te = termEnd();
    if (anchor() !== mineCode() || te == null || te <= day || day >= addDays(te, -49)) return 0;
    return feeOf(mineCode());
  };
  /**
   * One pick over [state.from, compareEnd()) and the viewer's fuels: `run`, its running £ at the start of each day and
   * at the end (null from the first unpriced day on), and `unpriced`, its days up to the cutoff with no rate. A fixed
   * pick rolls on to the Flexible version on sale now at its term end.
   */
  const runOf = (key) => {
    const from = state.from;
    const end = compareEnd();
    const te = termOf(key) ?? end;
    const daily = dailyOver(key, from, te < from ? from : te > end ? end : te, end);
    const run = [0];
    for (const c of daily) run.push(c == null || run.at(-1) == null ? null : run.at(-1) + c);
    const unpriced = [];
    for (let i = 0, d = from; d <= cutoff(); i++, d = addDays(d, 1)) if (daily[i] == null) unpriced.push(d);
    return { key, run, unpriced };
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
  /** Where a tariff's unpriced days up to the cutoff sit: at the start, at the end, one gap inside, or several gaps. */
  const unpricedText = ({ unpriced }) => {
    const runs = [];
    for (const d of unpriced) {
      if (runs.length && addDays(runs.at(-1)[1], 1) === d) runs.at(-1)[1] = d;
      else runs.push([d, d]);
    }
    if (runs.length > 1) return 'no rates on some days';
    const [[a, b]] = runs;
    const atStart = a === state.from;
    const atEnd = b === cutoff();
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
      if (ds.lineId === 'cap' || ds.lineId === 'mine' || y == null || !chart.isDatasetVisible(k)) return;
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
    $('mine').replaceChildren(
      el('option', { value: '', textContent: 'no fixed contract (Flexible)' }),
      ...optgroups([]),
    );
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
    if (mineEnded()) {
      const a = annualNow(flexCode());
      line.replaceChildren(
        term('fixed', 'Fixed term ended'),
        ` ${fmtDate(addDays(termEnd(), -1))} · you are now on ${flexFamily().label}`,
        ...(a == null ? [] : [` · about ${pounds(a)}/yr`]),
        '.',
      );
      return;
    }
    const a = annualNow(code);
    const about = a == null ? [] : [` · about ${pounds(a)}/yr`];
    if (family.kind === 'fixed') {
      const fee = feeOf(code);
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
    // "if I switch" looks forward from the switch date: the from date has no part in it
    const sw = state.cmode === 'switch';
    Object.assign($('from'), { min: MIN_START, max: yesterday(), value: state.from, disabled: sw });
    $('switch-field').hidden = !sw;
    Object.assign($('switch'), { min: cutoff(), max: lastSwitch(), value: state.switchOn });
    $('lead').replaceChildren(
      ...(sw
        ? [
            term('switch', 'If you switch'),
            ' on ',
            el('b', { textContent: fmtDate(state.switchOn) }),
            ': ',
            term('exitfee', 'exit fee'),
            " once, then the new tariff's rates; the line crosses £0 when it has paid back.",
          ]
        : [
            'From ',
            el('b', { textContent: fmtDate(state.from) }),
            ': solid, what each tariff would have ',
            term('compare', 'charged'),
            " so far; dashed, the next 12 months if today's rates stayed the same.",
          ]),
    );
    if (sw) {
      drawSwitch();
      return;
    }
    const vs = state.cmode === 'vs';
    const you = anchor();
    const runs = new Map([...new Set([...state.picked, ...(vs ? [you] : [])])].map((k) => [k, runOf(k)]));
    const base = vs ? runs.get(you).run : null;
    const cut = Math.round((ms(cutoff()) - ms(state.from)) / DAY); // the point at the cutoff: the end of "so far"
    const valuesOf = ({ key, run }) =>
      vs ? run.map((v, i) => (v == null || base[i] == null ? null : key === you ? 0 : v - base[i])) : run;
    const c = charts.compare;
    c.data.datasets = state.picked
      .map((key) => runs.get(key))
      .filter((r) => !r.unpriced.length)
      .flatMap((r) => {
        const ys = valuesOf(r);
        const mine = r.key === mineCode();
        const te = termOf(r.key);
        const mark = te != null && te > state.from ? Math.round((ms(te) - ms(state.from)) / DAY) : -1;
        const line = (part, keep) =>
          compareLine({
            key: r.key,
            label: `${shortName(r.key)}${part === 'future' ? " (at today's rates)" : ''}`,
            ink: mine,
            part,
            cut,
            mark,
            data: ys.map((y, i) => ({ x: ms(state.from) + i * DAY, y: keep(i) ? y : null })),
          });
        return [line('past', (i) => i <= cut), line('future', (i) => i >= cut)];
      });
    Object.assign(c.options.scales.x, { min: ms(state.from), max: ms(compareEnd()) });
    Object.assign(
      c.options.scales.y,
      vs
        ? { min: undefined, suggestedMin: -50, suggestedMax: 50 }
        : { min: 0, suggestedMin: undefined, suggestedMax: undefined },
    );
    c.update('none');
    // the totals: so far (to the cutoff) and in a year (to the chart's end), each signed against mine in vs yours
    const amount = (v) => (v == null ? '–' : pounds(v)); // null: the roll-on or projection has no rate today
    const figure = (v, b) => {
      const d = signed(v, b);
      if (!d) return b == null ? '–' : '£0';
      return el('span', { className: `delta ${d[0] === '−' ? 'down' : 'up'}`, textContent: d });
    };
    $('totals').replaceChildren(
      ...state.picked.map((key) => {
        const r = runs.get(key);
        const figures = r.unpriced.length
          ? [el('span', { className: 'unranked', textContent: unpricedText(r) })]
          : vs && key !== you
            ? ['so far ', figure(r.run[cut], base[cut]), ' · in a year ', figure(r.run.at(-1), base.at(-1))]
            : [`so far ${amount(r.run[cut])} · in a year ${amount(r.run.at(-1))}`];
        return totalsRow(key, key === mineCode(), figures);
      }),
    );
  };
  /** A totals row: the line's key (in ink when `ink`), the name, its type, "you" on the anchor, then its figures. */
  const totalsRow = (key, ink, figures) =>
    el(
      'li',
      { dataset: { key } },
      el('span', {
        className: `key${key === 'cap' ? ' dash' : ''}`,
        style: `--c:${ink ? 'var(--text)' : colourOf(key)}`,
      }),
      el(
        'span',
        { className: 'name' },
        el('b', { textContent: shortName(key) }),
        ' ',
        el('span', { className: 'type', textContent: `(${typeOf(key)})` }),
        ...(key === anchor() ? [' ', el('span', { className: 'you-tag', textContent: 'you' })] : []),
      ),
      el('span', { className: 'figures' }, ...figures),
    );
  /**
   * "If I switch": from the switch date s to the comparison's end, each pick's line is the exit fee plus its running £
   * against staying put on the anchor, all at the cutoff's rates. Staying: my fixed tariff until its term end, then
   * Flexible; a variable anchor its own rates. Moving: a fixed pick for its term from s, then Flexible; a variable pick
   * or the cap its own rates. The anchor is flat at 0; a pick with no rate on any day has no line.
   */
  const drawSwitch = () => {
    const s = state.switchOn;
    const end = compareEnd();
    const a = anchor();
    const within = (d) => (d < s ? s : d > end ? end : d);
    /** The exclusive end of a key's fixed term when it is taken on s (mine: its own term end); null if not fixed. */
    const termFrom = (key) => {
      if (key === a) return termEnd();
      if (key === 'cap') return null;
      const { family, version } = versionInfo.get(key);
      return family.kind === 'fixed' ? addMonths(s, version.term) : null;
    };
    const daysTo = (d) => Math.round((ms(d) - ms(s)) / DAY);
    const stay = dailyOver(a, s, within(termFrom(a) ?? end), end);
    const stayPriced = stay.every((v) => v != null);
    const fee = exitFeeOn(s);
    const ysOf = (key) => {
      if (!stayPriced) return null;
      if (key === a) return Array(stay.length + 1).fill(0);
      const move = dailyOver(key, s, within(termFrom(key) ?? end), end);
      if (move.some((v) => v == null)) return null;
      const ys = [fee];
      for (let i = 0; i < move.length; i++) ys.push(ys[i] + move[i] - stay[i]);
      return ys;
    };
    const lines = new Map(state.picked.map((key) => [key, ysOf(key)]));
    const c = charts.compare;
    c.data.datasets = state.picked
      .filter((key) => lines.get(key))
      .map((key) => {
        const te = termFrom(key);
        return compareLine({
          key,
          label: shortName(key),
          ink: key === a,
          part: 'future',
          cut: -1,
          mark: te != null && te > s ? daysTo(te) : -1,
          data: lines.get(key).map((y, i) => ({ x: ms(s) + i * DAY, y })),
        });
      });
    Object.assign(c.options.scales.x, { min: ms(cutoff()), max: ms(end) });
    Object.assign(c.options.scales.y, { min: undefined, suggestedMin: -50, suggestedMax: 50 });
    c.update('none');
    $('totals').replaceChildren(
      ...state.picked.map((key) => {
        const ys = lines.get(key);
        let figures;
        if (!ys) figures = [el('span', { className: 'unranked', textContent: 'no rates today' })];
        else if (key === a)
          figures = [
            fee ? `stay · exit fee ${pounds(fee)} until ${fmtDate(addDays(termEnd(), -49))}` : 'stay · no exit fee',
          ];
        else {
          const y = ys.at(-1);
          // paid back from the day after the line is last above £0; a dip below that climbs back is not a pay-back
          const lastAbove = ys.findLastIndex((v) => v > 0);
          const back = lastAbove === ys.length - 1 ? -1 : Math.max(lastAbove + 1, 1);
          const delta = (ahead, text) => el('span', { className: `delta ${ahead ? 'down' : 'up'}`, textContent: text });
          figures =
            Math.abs(y) < 1
              ? ['£0 in a year']
              : back > 0
                ? [delta(true, `pays back ${fmtDate(addDays(s, back - 1))} · ${pounds(-y)} ahead in a year`)]
                : [delta(false, `doesn't pay back within a year · ${pounds(y)} behind`)];
        }
        return totalsRow(key, key === a, figures);
      }),
    );
  };
  /** One line of the compare chart: `part` past (solid) or future (dashed), in ink for my tariff, a 6px point at `mark`. */
  const compareLine = ({ key, label, ink, part, cut, mark, data }) => {
    const colour = ink ? css('--text') : css(colourOf(key));
    const marked = (ctx) => (ctx.dataIndex === mark && ctx.raw?.y != null ? 3 : 0);
    return dataset({
      label,
      lineId: key,
      part,
      cut,
      data,
      borderColor: colour,
      backgroundColor: colour,
      borderWidth: ink ? 3 : 2,
      borderDash: part === 'future' ? [3, 3] : key === 'cap' ? [6, 4] : [],
      order: ink ? -1 : key === 'cap' ? 1 : 0,
      pointStyle: 'circle',
      pointRadius: marked, // the term-end marker, where a fixed pick rolls on to Flexible
      pointHoverRadius: marked,
      pointBorderWidth: 0,
    });
  };
  /** "−£n" or "+£n" of `v` against `base`; null when either is missing or they are within £1. */
  const signed = (v, base) => {
    if (v == null || base == null || Math.abs(v - base) < 1) return null;
    return `${v < base ? '−' : '+'}${pounds(Math.abs(v - base))}`;
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
  /** The text of my tariff's chip: today's estimate, or the day its fixed term ended. */
  const mineText = () => {
    if (mineEnded()) return `ended ${fmtDate(addDays(termEnd(), -1))}`;
    const a = annualNow(mineCode());
    return a == null ? '' : `about ${pounds(perMonth() ? a / 12 : a)}${perLabel()}`;
  };
  /** A chip toggles its line on every chart; hovering it with a mouse, or focusing it from the keyboard, emphasises it. */
  const chip = (id, key, name, text, disabled = false) => {
    const b = el(
      'button',
      { type: 'button', className: 'chip', disabled, dataset: { line: id } },
      key,
      el('b', { textContent: name }),
      el('small', { textContent: text }),
    );
    b.setAttribute('aria-pressed', String(!disabled && !state.off.has(id)));
    if (disabled) return b;
    b.addEventListener('click', () => {
      if (state.off.has(id)) state.off.delete(id);
      else state.off.add(id);
      draw();
    });
    b.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && emphasise(id));
    b.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && emphasise(null));
    b.addEventListener('focus', () => b.matches(':focus-visible') && emphasise(id));
    b.addEventListener('blur', () => emphasise(null));
    return b;
  };
  const drawChips = () => {
    const code = mineCode();
    $('chips').replaceChildren(
      ...state.lines.map((line) => {
        const text = chipText(line);
        return chip(
          line.id,
          el('span', { className: `key${line.dash ? ' dash' : ''}`, style: `--c:${line.colour}` }),
          line.kind === 'variable' ? `${line.label} (variable)` : line.label,
          text ?? `not sold in ${regionName(state.shown)}`,
          text == null,
        );
      }),
      ...(code
        ? [
            chip(
              'mine',
              el('span', { className: 'key', style: '--c:var(--text)' }),
              `You: ${shortName(code)}`,
              mineText(),
            ),
          ]
        : []),
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
      c.data.datasets = datasetsFor(
        (line, day) => rate(line, p.fuel, p.field, day),
        (day) => mineRow(p.fuel, day)?.[p.field] ?? null,
      );
      Object.assign(c.options.scales.x, { min: ms(view.from), max: ms(view.to) });
      c.update('none');
    }
    const a = charts.annual;
    a.data.datasets = datasetsFor(
      (line, day) => cost(line, day),
      (day) => costOfRows((fuel) => mineRow(fuel, day)),
    );
    Object.assign(a.options.scales.x, { min: ms(view.from), max: ms(view.to) });
    a.update('none');
    drawChips();
    drawTitles();
    drawMine();
    drawCompare();
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
    for (const id of ['mine', 'add', 'from', 'switch']) $(id).disabled = !state.lines;
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
  segment('cmode', (v) => {
    state.cmode = v;
  });

  const onUsage = () => {
    const read = (input) => (input.value.trim() === '' ? null : Math.max(0, Number(input.value) || 0));
    kwh.electricity = read($('kwh-electricity')) ?? 0;
    kwh.gas = read($('kwh-gas'));
    remember(USAGE_KEY, JSON.stringify(kwh));
    draw();
  };
  $('kwh-electricity').addEventListener('input', onUsage);
  $('kwh-gas').addEventListener('input', onUsage);

  // Choosing my tariff resets the comparison onto it: it and Flexible, from its since-date.
  $('mine').addEventListener('change', () => {
    if (!state.lines) return;
    const code = $('mine').value || null;
    state.mine = code ? { code, since: null } : null;
    saveMine();
    resetComparison();
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
  $('switch').addEventListener('change', () => {
    const day = $('switch').value;
    if (!state.lines || !day) return;
    state.switchOn = day < cutoff() ? cutoff() : day > lastSwitch() ? lastSwitch() : day;
    draw();
  });

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
    const active = dayElements(chart, i).filter(
      (e) => !lineId || chart.data.datasets[e.datasetIndex].lineId === lineId,
    );

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
      showView();
      drawFooter();
      return;
    }
    if (state.region !== region) return; // superseded by a later pick: its response decides
    state.lines = lineSet(region, files);
    state.shown = region;
    view = range();
    resetComparison();
    state.switchOn = cutoff();
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
