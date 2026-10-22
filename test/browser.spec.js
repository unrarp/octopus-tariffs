import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from '../src/build.js';
import { annualAt, capSeries, costSince, dailyCosts, versionSeries } from '../src/site/lib/compare.js';
import { annualCost } from '../src/site/lib/cost.js';

const ROOT = fileURLToPath(new URL('./fixtures/build', import.meta.url));
const BUILT = new Date('2026-10-21T06:00:00.000Z'); // the fixture's collection time, the build's generatedAt
const NOW = Date.parse('2026-10-21T12:00:00.000Z'); // the viewer's clock: the build's day
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const PREFIX = '/octopus-tariffs/';
const IPINFO = 'https://ipinfo.io/json';
const GSP = 'https://api.octopus.energy/v1/industry/grid-supply-points/**';
const OUTWARD = 'ZZ1'; // a made-up outward code, nobody's postcode
const CHARTS = ['electricity-unit', 'electricity-standing', 'gas-unit', 'gas-standing', 'annual'];

// Built in beforeAll, not at load: Playwright also loads this file in its main process, which runs no hooks.
let out;
let server;
let base;
test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'ot-browser-'));
  await build({ root: ROOT, out, now: BUILT, warn: () => {} });
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    let file = url.startsWith(PREFIX) ? join(out, normalize(url.slice(PREFIX.length))) : null;
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}${PREFIX}`;
});
test.afterAll(() => {
  server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

/**
 * Opens the page with both geolocation calls intercepted: `ip` is the ipinfo answer or 'fail', `gsp` the region the
 * grid-supply-points lookup returns or 'fail'. `stored` pre-sets the remembered region. Returns the console errors.
 */
async function open(page, path = '', { ip = { country: 'GB', postal: OUTWARD }, gsp = '_C', stored, at = NOW } = {}) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(IPINFO, (r) => (ip === 'fail' ? r.abort('failed') : r.fulfill({ json: ip })));
  await page.route(GSP, (r) =>
    gsp === 'fail' ? r.abort('failed') : r.fulfill({ json: { results: [{ group_id: gsp }] } }),
  );
  if (stored) await page.addInitScript((r) => localStorage.setItem('octopus-tariffs:region', r), stored);
  await page.clock.setFixedTime(at);
  await page.goto(base + path);
  await page.waitForSelector('body[data-ready]', { state: 'attached', timeout: 10_000 });
  return errors;
}
const view = (page, v) => page.click(`#view button[data-v="${v}"]`);
/** The y values of one line of one chart, one per day (each day is drawn as two points). */
const values = (page, chart, label) =>
  page.evaluate(
    ([c, l]) =>
      __charts[c].data.datasets
        .find((d) => d.label === l)
        .data.filter((_, i) => i % 2 === 0)
        .map((p) => p.y),
    [chart, label],
  );
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const pressedWindow = (page) => page.locator('#window button[aria-pressed="true"]').getAttribute('data-v');
const tip = (page) =>
  page.evaluate(() => {
    const t = __charts['electricity-unit'].tooltip;
    return { opacity: t.opacity, title: t.title, body: (t.body ?? []).flatMap((b) => b.lines) };
  });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const [name, viewport] of [
  ['desktop 1280x800', { width: 1280, height: 800 }],
  ['phone 390x844', { width: 390, height: 844 }],
]) {
  test.describe(name, () => {
    test.use({ viewport });

    test('loads with no console errors: four rates panels, one line per family plus the cap', async ({ page }) => {
      const errors = await open(page);
      await expect(page.locator('#rates')).toBeVisible();
      const lines = await page.evaluate(() => __charts['electricity-unit'].data.datasets.map((d) => d.label));
      expect(lines).toEqual(['Ofgem price cap, London', '12M Fixed', '6M Winter Fix', 'Flexible Octopus']);
      await expect(page.locator('#footer')).toHaveText(
        'Data: Octopus Energy public API · London · direct debit · prices inc VAT · updated 21 Oct 2026.',
      );
      await page.selectOption('#mine', 'OE-FIX-12M-26-01-15'); // my tariff adds its line last
      const withMine = await page.evaluate(() => __charts['electricity-unit'].data.datasets.map((d) => d.label));
      expect(withMine).toEqual([...lines, MINE]);
      expect(errors).toEqual([]);
    });

    test('no horizontal overflow in either view', async ({ page }) => {
      await open(page);
      expect(await noOverflow(page)).toBe(true);
      await view(page, 'annual');
      expect(await noOverflow(page)).toBe(true);
    });
  });
}

test('the view control swaps the rates grid and the annual-cost chart; Per year | Per month only in Annual cost', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('#rates')).toBeVisible();
  await expect(page.locator('#annual')).toBeHidden();
  await expect(page.locator('#per')).toBeHidden();
  await view(page, 'annual');
  await expect(page.locator('#rates')).toBeHidden(); // [hidden] beats display: grid
  await expect(page.locator('#annual')).toBeVisible();
  await expect(page.locator('#per')).toBeVisible();
  await view(page, 'rates');
  await expect(page.locator('#rates')).toBeVisible();
  await expect(page.locator('#annual')).toBeHidden();
});

test('every y axis starts at zero, and no panel title touches its top tick', async ({ page }) => {
  await open(page);
  await view(page, 'annual');
  await view(page, 'rates'); // the annual chart has been laid out once
  const axes = await page.evaluate((ids) => ids.map((id) => __charts[id].scales.y.min), CHARTS);
  expect(axes).toEqual([0, 0, 0, 0, 0]);
  const gaps = await page.evaluate(
    (ids) =>
      ids.slice(0, 4).map((id) => {
        const c = __charts[id];
        const title = document.getElementById(`t-${id}`).getBoundingClientRect();
        const tickTop = c.canvas.getBoundingClientRect().top + c.chartArea.top - 7; // half a 12px label above the top gridline
        return tickTop - title.bottom;
      }),
    CHARTS,
  );
  for (const g of gaps) expect(g).toBeGreaterThanOrEqual(2);
});

test('changing usage redraws the £/yr lines and chips; an empty gas field drops gas', async ({ page }) => {
  await open(page);
  await view(page, 'annual');
  const before = (await values(page, 'annual', 'Flexible Octopus')).at(-1);
  const chip = page.locator('.chip[data-line="flexible"] small');
  const chipBefore = await chip.textContent();
  expect(chipBefore).toMatch(/^about £[\d,]+\/yr$/);
  await page.fill('#kwh-electricity', '3500');
  const after = (await values(page, 'annual', 'Flexible Octopus')).at(-1);
  expect(after - before).toBeCloseTo(1000 * 0.266, 6); // 1,000 kWh more at 26.6 p/kWh (0 % VAT on electricity from 2026-10-01)
  await expect(chip).not.toHaveText(chipBefore);
  await page.fill('#kwh-gas', '');
  const elecOnly = (await values(page, 'annual', 'Flexible Octopus')).at(-1);
  expect(elecOnly).toBeCloseTo((26.6 * 3500 + 41.4 * 365) / 100, 6);
  await view(page, 'rates');
  await expect(page.locator('#t-gas-unit')).toContainText('no gas supply');
  await view(page, 'annual');
  await page.click('#per button[data-v="month"]');
  expect((await values(page, 'annual', 'Flexible Octopus')).at(-1)).toBeCloseTo(elecOnly / 12, 6);
  await expect(chip).toHaveText(/^about £[\d,]+\/month$/);
});

test('changing the window redraws every chart over the new span', async ({ page }) => {
  await open(page);
  const span = () =>
    page.evaluate(() => {
      const c = __charts['electricity-unit'];
      return { min: new Date(c.scales.x.min).toISOString().slice(0, 10), days: c.data.datasets[0].data.length / 2 };
    });
  expect(await span(page)).toEqual({ min: '2025-10-22', days: 365 });
  await page.click('#window button[data-v="6"]');
  expect(await span(page)).toEqual({ min: '2026-04-22', days: 183 });
  await page.click('#window button[data-v="all"]');
  expect((await span(page)).min).toBe('2025-01-01');
});

test('a window ending on 31 Aug starts on 28 Feb, not 3 Mar: months are clamped to the month end', async ({ page }) => {
  // The data as a build on 30 Aug would have it: every daily series cut after that day.
  await page.route('**/data/_*/*.json', async (route) => {
    const file = await (await route.fetch()).json();
    for (const fuel of ['electricity', 'gas']) file[fuel].days = file[fuel].days.filter((p) => p.day <= '2026-08-30');
    await route.fulfill({ json: file });
  });
  await open(page, '', { at: Date.parse('2026-08-30T12:00:00Z') });
  await page.click('#window button[data-v="6"]');
  const min = await page.evaluate(() => new Date(__charts['electricity-unit'].scales.x.min).toISOString().slice(0, 10));
  expect(min).toBe('2026-02-28');
});

test('dashed cap-change verticals are drawn at every cap change in range, on every chart', async ({ page }) => {
  await open(page);
  await view(page, 'annual');
  await expect // the annual chart paints once it has been laid out
    .poll(() => page.evaluate((ids) => ids.map((id) => __charts[id].$markers), CHARTS))
    .toEqual(CHARTS.map(() => ['2026-10-01']));
});

test('a chip hides its line on every chart and shows it again, the You chip included', async ({ page }) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  // dataset 3: Flexible, dataset 4: mine
  for (const [line, k] of [
    ['flexible', 3],
    ['mine', 4],
  ]) {
    const visible = () => page.evaluate(([ids, k]) => ids.map((id) => __charts[id].isDatasetVisible(k)), [CHARTS, k]);
    expect(await visible()).toEqual([true, true, true, true, true]);
    await page.click(`#chips .chip[data-line="${line}"]`);
    await expect(page.locator(`#chips .chip[data-line="${line}"]`)).toHaveAttribute('aria-pressed', 'false');
    expect(await visible()).toEqual([false, false, false, false, false]);
    await page.click(`#chips .chip[data-line="${line}"]`);
    expect(await visible()).toEqual([true, true, true, true, true]);
  }
});

test('hovering a chip emphasises its line on every chart: the others fade to 30% and revert on leave', async ({
  page,
}) => {
  await open(page);
  const styles = () =>
    page.evaluate(
      (ids) => ids.map((id) => __charts[id].data.datasets.map((d) => [d.lineId, d.borderColor, d.borderWidth])),
      CHARTS,
    );
  const before = await styles();
  for (const chart of before) for (const [, colour] of chart) expect(colour).toMatch(/^rgb\(/);
  await page.hover('#chips .chip[data-line="flexible"]');
  const faded = (c) => c.replace('rgb(', 'rgba(').replace(')', ', 0.3)');
  expect(await styles()).toEqual(
    before.map((chart) => chart.map(([id, c, w]) => (id === 'flexible' ? [id, c, w + 1] : [id, faded(c), w]))),
  );
  await page.mouse.move(0, 0);
  expect(await styles()).toEqual(before);
});

test('an off-sale gap breaks a line: 12M Fixed is drawn on either side of its March–May gap and not inside it', async ({
  page,
}) => {
  await open(page);
  // The column of canvas pixels at noon on `day`, searched for the 12M Fixed line colour.
  const inked = (day) =>
    page.evaluate((d) => {
      const c = __charts['electricity-unit'];
      const ds = c.data.datasets.find((x) => x.label === '12M Fixed');
      const [r, g, b] = ds.borderColor.match(/\d+/g).map(Number);
      const dpr = c.currentDevicePixelRatio;
      const x = Math.round(c.scales.x.getPixelForValue(Date.parse(`${d}T12:00:00Z`)) * dpr);
      const y0 = Math.round(c.chartArea.top * dpr);
      const px = c.ctx.getImageData(x, y0, 1, Math.round(c.chartArea.bottom * dpr) - y0).data;
      for (let i = 0; i < px.length; i += 4)
        if (Math.abs(px[i] - r) + Math.abs(px[i + 1] - g) + Math.abs(px[i + 2] - b) < 30 && px[i + 3] > 200)
          return true;
      return false;
    }, day);
  expect(await inked('2026-02-15')).toBe(true);
  expect(await inked('2026-04-01')).toBe(false);
  expect(await inked('2026-06-01')).toBe(true);
});

test('#<productCode> opens that version’s tooltip on its first day on sale; #YYYY-MM-DD opens the day’s', async ({
  page,
}) => {
  await open(page, '#OE-FIX-12M-26-05-10');
  expect(await tip(page)).toEqual({
    opacity: 1,
    title: ['10 May 2026'],
    body: ['12M May 2026 v1 · 29.4 p/kWh'],
  });
  await page.evaluate(() => {
    location.hash = '#2026-08-01';
  });
  await expect.poll(async () => (await tip(page)).title).toEqual(['1 Aug 2026']);
  expect((await tip(page)).body).toEqual([
    'Ofgem price cap · 25.7 p/kWh',
    '12M May 2026 v1 · 29.4 p/kWh',
    'Flexible Octopus December 2025 v2 · 27.8 p/kWh',
  ]);
});

test('hovering a day on one rates panel shows that day’s tooltip on all four; moving out clears them', async ({
  page,
}) => {
  await open(page);
  await frames(page);
  const at = await page.evaluate(() => {
    const c = __charts['gas-unit'];
    const box = c.canvas.getBoundingClientRect();
    return {
      x: box.left + c.scales.x.getPixelForValue(Date.parse('2026-08-01T12:00:00Z')),
      y: box.top + (c.chartArea.top + c.chartArea.bottom) / 2,
    };
  });
  const tips = () =>
    page.evaluate(
      (ids) => ids.map((id) => [__charts[id].tooltip.getActiveElements().length > 0, __charts[id].tooltip.title]),
      CHARTS.slice(0, 4),
    );
  await page.mouse.move(at.x, at.y);
  await expect.poll(tips).toEqual(CHARTS.slice(0, 4).map(() => [true, ['1 Aug 2026']]));
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await tips()).map(([on]) => on)).toEqual([false, false, false, false]);
});

test('a day deep link before the current window widens the window to the smallest that holds it', async ({ page }) => {
  await open(page, '#2025-06-01');
  expect(await pressedWindow(page)).toBe('24');
  expect((await tip(page)).title).toEqual(['1 Jun 2025']);
});

test('a day deep link before the first data day leaves the page as it is', async ({ page }) => {
  const errors = await open(page, '#2020-01-01');
  expect(errors).toEqual([]);
  expect(await pressedWindow(page)).toBe('12');
  expect((await tip(page)).opacity).toBe(0);
});

test('a malformed hash is no deep link, on load and on hashchange', async ({ page }) => {
  const errors = await open(page, '#%E0%A4%A');
  await page.evaluate(() => {
    location.hash = '#%E0%A4%B';
  });
  await frames(page);
  expect(errors).toEqual([]);
});

test('#fn-<id> opens the dialog at that definition', async ({ page }) => {
  await open(page, '#fn-tdcv');
  await expect(page.locator('#help')).toBeVisible();
  await expect(page.locator('#fn-tdcv')).toHaveClass('current');
});

test('choosing a region in the select loads its data and remembers it; ?region= deep links one', async ({ page }) => {
  await open(page);
  const loaded = page.waitForRequest((r) => r.url().endsWith('/data/_G/flexible.json'));
  await page.selectOption('#region', '_G');
  await loaded;
  await expect(page.locator('#footer')).toContainText('· North West ·');
  await expect(page.locator('.chip[data-line="oe-fix-6m"]')).toBeDisabled();
  await expect(page.locator('.chip[data-line="oe-fix-6m"] small')).toHaveText('not sold in North West');
  await expect(page.locator('.chip[data-line="oe-fix-12m"] small')).toHaveText('not on sale');
  await expect(page.locator('.chip[data-line="cap"] small')).toHaveText('next period not yet entered');
  expect(await page.evaluate(() => localStorage.getItem('octopus-tariffs:region'))).toBe('_G');
  await page.goto(`${base}?region=_C`); // the deep link beats the remembered region
  await page.waitForSelector('body[data-ready]', { state: 'attached' });
  await expect(page.locator('#region')).toHaveValue('_C');
});

test('IP geolocation picks the region through the grid-supply-points lookup of the outward code', async ({ page }) => {
  const asked = page.waitForRequest((r) => r.url().includes('grid-supply-points'));
  await open(page, '', { gsp: '_G' });
  expect(new URL((await asked).url()).searchParams.get('postcode')).toBe(OUTWARD);
  await expect(page.locator('#region')).toHaveValue('_G');
});

test('London is the default when both IP lookups fail', async ({ page }) => {
  await open(page, '', { ip: 'fail', gsp: 'fail' });
  await expect(page.locator('#region')).toHaveValue('_C');
  await expect(page.locator('#footer')).toContainText('· London ·');
});

test('a remembered region wins over the IP guess', async ({ page }) => {
  await open(page, '', { gsp: '_G', stored: '_C' });
  await expect(page.locator('#region')).toHaveValue('_C');
});

test('a slow region response superseded by a later pick is ignored', async ({ page }) => {
  await open(page);
  let released = 0;
  await page.route('**/data/_G/*.json', async (route) => {
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ response: res });
    released++;
  });
  await page.selectOption('#region', '_G');
  await page.selectOption('#region', '_C');
  await expect.poll(() => released).toBe(4);
  await page.waitForTimeout(300); // the late responses have been parsed and, if not ignored, drawn
  const cap = await page.evaluate(() => __charts['electricity-unit'].data.datasets[0].label);
  expect(cap).toBe('Ofgem price cap, London');
  expect((await values(page, 'electricity-unit', 'Flexible Octopus')).at(-1)).toBe(26.6); // North West's is 27.6
  await expect(page.locator('#footer')).toContainText('· London ·');
});

test('a region whose data fails to load shows the error and no chart, whichever view is picked', async ({ page }) => {
  await open(page);
  await page.route('**/data/_G/*.json', (route) => route.fulfill({ status: 500 }));
  await page.selectOption('#region', '_G');
  await expect(page.locator('#load-error')).toHaveText('Could not load data for North West');
  await expect(page.locator('#chips .chip')).toHaveCount(0);
  for (const v of ['annual', 'rates']) {
    await view(page, v);
    await expect(page.locator('#rates')).toBeHidden();
    await expect(page.locator('#annual')).toBeHidden();
  }
});

test('a failed families.json shows an error in the page, not a blank one', async ({ page }) => {
  await page.route('**/data/families.json', (route) => route.fulfill({ status: 500 }));
  await page.route(IPINFO, (r) => r.abort('failed'));
  await page.goto(base);
  await expect(page.locator('#load-error')).toHaveText('Could not load data');
  await expect(page.locator('#rates')).toBeHidden();
});

test('usage is remembered: a reload restores it', async ({ page }) => {
  await open(page);
  await page.fill('#kwh-electricity', '3000');
  await page.fill('#kwh-gas', '');
  await page.reload();
  await page.waitForSelector('body[data-ready]', { state: 'attached' });
  await expect(page.locator('#kwh-electricity')).toHaveValue('3000');
  await expect(page.locator('#kwh-gas')).toHaveValue('');
  await expect(page.locator('#t-gas-unit')).toContainText('no gas supply');
});

test('the (i) dialog lists every definition; a term link opens it at its entry', async ({ page }) => {
  await open(page);
  await page.click('#info');
  await expect(page.locator('#help')).toBeVisible();
  await expect(page.locator('#fn-cap')).toContainText("Ofgem's cap on standard variable tariffs");
  await expect(page.locator('#fn-tdcv')).toContainText('revised 1 July 2026');
  await page.click('#help-close');
  await page.click('#legend-cap a.term[href="#fn-cap"]');
  await expect(page.locator('#fn-cap')).toHaveClass('current');
});

test('link check: no href, src, fetch or import starts with /', async ({ page }) => {
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await open(page);
  const attrs = await page.evaluate(() =>
    [...document.querySelectorAll('[href],[src]')].map((n) => n.getAttribute('href') ?? n.getAttribute('src')),
  );
  expect(attrs.filter((a) => a.startsWith('/'))).toEqual([]);
  const external = (u) => u.startsWith('https://ipinfo.io/') || u.startsWith('https://api.octopus.energy/');
  expect(requests.filter((u) => !u.startsWith(base) && !external(u))).toEqual([]);
  const files = (dir) =>
    readdirSync(dir, { recursive: true })
      .map((f) => join(dir, f))
      .filter((f) => /\.(html|js|css)$/.test(f) && !f.includes(`${join(out, 'vendor')}`));
  const absolute =
    /(?:href|src)\s*=\s*["']\/|fetch\(\s*[`'"]\/|get\(\s*[`'"]\/|\bimport\b[^;'"`]*['"`]\/|from\s+['"`]\/|url\(\s*['"]?\//;
  const hits = files(out).filter((f) => absolute.test(readFileSync(f, 'utf8')));
  expect(hits.map((f) => relative(out, f))).toEqual([]);
});

// ---- the comparison: expected £ figures come from the same lib on the same built files ----
const CUTOFF = '2026-10-21'; // the fixture's generatedAt day: comparisons run up to it
const FAMILY = {
  'OE-FIX-12M': ['oe-fix-12m', 'fixed'],
  'OE-FIX-6M-': ['oe-fix-6m', 'fixed'],
  'VAR-': ['flexible', 'variable'],
};
const builtFile = (region, id) => JSON.parse(readFileSync(join(out, 'data', region, `${id}.json`), 'utf8'));
const seriesOf = (code, fuel, region = '_C') => {
  if (code === 'cap') return capSeries(builtFile(region, 'cap')[fuel]);
  const [id, kind] = Object.entries(FAMILY).find(([p]) => code.startsWith(p))[1];
  return versionSeries(kind, builtFile(region, id)[fuel], code);
};
const usage = (gas = true) => ({ electricity: 2500, ...(gas ? { gas: 9500 } : {}) });
const costFrom = (code, from, kwh = usage(), to = CUTOFF) =>
  Object.entries(kwh).reduce((sum, [fuel, k]) => sum + costSince(seriesOf(code, fuel), from, to, fuel, k).cost, 0);
const yearNow = (code, kwh = usage()) =>
  Object.entries(kwh).reduce((sum, [fuel, k]) => sum + annualAt(seriesOf(code, fuel), CUTOFF, k), 0);
const gbp = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;
const picked = (page) => page.locator('#picked .chip').evaluateAll((cs) => cs.map((c) => c.dataset.key));
const END = '2027-10-21'; // 12 months after the cutoff: the comparison chart's right edge
const FLEX = 'VAR-25-12-15'; // the Flexible version on sale at the cutoff
/**
 * £ per day of `code` over [from, END) at the viewer's fuels, as the comparison prices it: a fixed pick's own rates
 * until `termEnd`, then the Flexible version on sale now; every day after the cutoff at the cutoff's rates.
 */
const dailyOf = (code, from, { kwh = usage(), termEnd = END } = {}) => {
  const split = termEnd > END ? END : termEnd;
  return Object.entries(kwh)
    .map(([fuel, k]) => [
      ...dailyCosts(seriesOf(code, fuel), from, split, fuel, k, CUTOFF),
      ...dailyCosts(seriesOf(FLEX, fuel), split, END, fuel, k, CUTOFF),
    ])
    .reduce((a, b) => a.map((v, i) => v + b[i]));
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const addDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** The comparison chart's datasets: {key, part, dash, points: [[day, y]]}, a point's day being its x (the day's start). */
const compareLines = (page) =>
  page.evaluate(() =>
    __charts.compare.data.datasets.map((d) => ({
      key: d.lineId,
      part: d.part,
      dash: d.borderDash,
      points: d.data.map((p) => [new Date(p.x).toISOString().slice(0, 10), p.y]),
    })),
  );
/** The y of one dataset of `key` at the start of `day` (the running total of the days before it). */
const at = (lines, key, part, day) =>
  lines.find((l) => l.key === key && l.part === part).points.find(([d]) => d === day)[1];
/** The totals rows in page order: [key, figures text]. */
const totals = (page) =>
  page
    .locator('#totals li')
    .evaluateAll((ls) => ls.map((l) => [l.dataset.key, l.querySelector('.figures').textContent]));
/** "−£n" / "+£n" of `v` against `base`, as the page signs a delta. */
const signed = (v, base) => `${v < base ? '−' : '+'}${gbp(Math.abs(v - base))}`;
const setFrom = async (page, day) => {
  await page.fill('#from', day);
  await page.locator('#from').dispatchEvent('change');
};

test('the comparison chart: each pick’s running £ from the date, solid to today, dashed for 12 months at today’s rates', async ({
  page,
}) => {
  const errors = await open(page);
  // No tariff of mine: anchored on the Flexible version on sale, then the latest launch, 12M May 2026; from yesterday.
  await expect(page.locator('#mine option').first()).toHaveText('no fixed contract (Flexible)');
  const picks = [FLEX, 'OE-FIX-12M-26-05-10'];
  expect(await picked(page)).toEqual(picks);
  await expect(page.locator('#from')).toHaveValue('2026-10-20');
  await expect(page.locator('#lead')).toHaveText(
    "From 20 Oct 2026: solid, what each tariff would have charged so far; dashed, the next 12 months if today's rates stayed the same.",
  );
  await expect(page.locator('#lead a.term')).toHaveAttribute('href', '#fn-compare');
  const lines = await compareLines(page);
  expect(lines.map((l) => [l.key, l.part, l.dash])).toEqual([
    [FLEX, 'past', []],
    [FLEX, 'future', [3, 3]],
    ['OE-FIX-12M-26-05-10', 'past', []],
    ['OE-FIX-12M-26-05-10', 'future', [3, 3]],
  ]);
  const want = {
    [FLEX]: dailyOf(FLEX, '2026-10-20'),
    'OE-FIX-12M-26-05-10': dailyOf('OE-FIX-12M-26-05-10', '2026-10-20', { termEnd: '2027-10-20' }),
  };
  for (const key of picks) {
    const past = lines.find((l) => l.key === key && l.part === 'past').points.filter(([, y]) => y != null);
    const future = lines.find((l) => l.key === key && l.part === 'future').points.filter(([, y]) => y != null);
    expect(past[0]).toEqual(['2026-10-20', 0]);
    expect(past.at(-1)[0]).toBe(CUTOFF);
    expect(past.at(-1)[1]).toBeCloseTo(costFrom(key, '2026-10-20'), 2);
    expect(future[0]).toEqual(past.at(-1));
    expect(future.at(-1)[0]).toBe(END);
    expect(future.at(-1)[1]).toBeCloseTo(sum(want[key]), 2);
  }
  expect(await totals(page)).toEqual(
    picks.map((k) => [k, `so far ${gbp(costFrom(k, '2026-10-20'))} · in a year ${gbp(sum(want[k]))}`]),
  );
  await expect(page.locator('#totals li[data-key="VAR-25-12-15"] .you-tag')).toHaveText('you');
  await expect(page.locator('#totals .you-tag')).toHaveCount(1);
  for (const id of ['#compare-hint', '#usage-hint', '#note', '.lede']) await expect(page.locator(id)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('vs yours: my tariff is flat at zero, every other pick its difference, signed in the totals; cheaper reads "−£n" in green', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-05-10'); // since 10 May 2026, its term to 10 May 2027
  await page.click('#cmode button[data-v="vs"]');
  await expect(page.locator('#cmode button[data-v="vs"]')).toHaveAttribute('aria-pressed', 'true');
  const from = '2026-05-10';
  const [fix, flex] = ['OE-FIX-12M-26-05-10', FLEX].map((c) => costFrom(c, from));
  expect(flex).toBeLessThan(fix - 1); // Flexible was cheaper, so mine is not the cheapest
  const lines = await compareLines(page);
  for (const l of lines.filter((x) => x.key === 'OE-FIX-12M-26-05-10'))
    for (const [, y] of l.points) if (y != null) expect(y).toBe(0);
  expect(at(lines, FLEX, 'past', CUTOFF)).toBeCloseTo(flex - fix, 2);
  const [fixYear, flexYear] = [
    sum(dailyOf('OE-FIX-12M-26-05-10', from, { termEnd: '2027-05-10' })),
    sum(dailyOf(FLEX, from)),
  ];
  expect(at(lines, FLEX, 'future', END)).toBeCloseTo(flexYear - fixYear, 2);
  expect(await totals(page)).toEqual([
    ['OE-FIX-12M-26-05-10', `so far ${gbp(fix)} · in a year ${gbp(fixYear)}`],
    [FLEX, `so far ${signed(flex, fix)} · in a year ${signed(flexYear, fixYear)}`],
  ]);
  expect(signed(flex, fix)).toMatch(/^−£/);
  const [down, good] = await page.evaluate(() => {
    const i = document.body.appendChild(document.createElement('i'));
    i.style.color = 'var(--good)';
    const c = getComputedStyle(i).color;
    i.remove();
    return [getComputedStyle(document.querySelector('#totals .delta.down')).color, c];
  });
  expect(down).toBe(good);
  expect(await page.evaluate(() => __charts.compare.scales.y.min)).toBeLessThan(0);
  await page.click('#cmode button[data-v="paid"]');
  expect(await page.evaluate(() => __charts.compare.scales.y.min)).toBe(0);
});

test('a fixed term that has ended: the mine line says so, and its pick rolls on to Flexible at its term end', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-6M-25-10-01'); // since its launch, 1 Oct 2025: 6 months to 1 Apr 2026
  await expect(page.locator('#mine-line')).toHaveText(
    `Fixed term ended 31 Mar 2026 · you are now on Flexible Octopus · about ${gbp(yearNow(FLEX))}/yr.`,
  );
  await expect(page.locator('#mine-line a.term')).toHaveAttribute('href', '#fn-fixed');
  expect(await picked(page)).toEqual(['OE-FIX-6M-25-10-01', FLEX]);
  await expect(page.locator('#chips .chip[data-line="mine"] small')).toHaveText('ended 31 Mar 2026');
  const lines = await compareLines(page);
  const step = (day) =>
    at(lines, 'OE-FIX-6M-25-10-01', 'past', addDay(day)) - at(lines, 'OE-FIX-6M-25-10-01', 'past', day);
  const own = (code, day) =>
    sum(Object.entries(usage()).map(([f, k]) => dailyCosts(seriesOf(code, f), day, addDay(day), f, k, CUTOFF)[0]));
  expect(step('2026-03-31')).toBeCloseTo(own('OE-FIX-6M-25-10-01', '2026-03-31'), 6); // the last day of its term
  for (const day of ['2026-04-01', '2026-08-01']) expect(step(day)).toBeCloseTo(own(FLEX, day), 6);
  const soFar = costFrom('OE-FIX-6M-25-10-01', '2025-10-01', usage(), '2026-04-01') + costFrom(FLEX, '2026-04-01');
  expect(at(lines, 'OE-FIX-6M-25-10-01', 'past', CUTOFF)).toBeCloseTo(soFar, 2);
  // the term-end marker: a 6px point on its line at 1 Apr 2026, none elsewhere
  const radii = await page.evaluate(() => {
    const c = __charts.compare;
    const k = c.data.datasets.findIndex((d) => d.lineId === 'OE-FIX-6M-25-10-01' && d.part === 'past');
    return c
      .getDatasetMeta(k)
      .data.flatMap((p, i) => (p.options.radius ? [[c.data.datasets[k].data[i].x, p.options.radius]] : []));
  });
  expect(radii).toEqual([[Date.parse('2026-04-01T00:00:00Z'), 3]]);
  // the You line runs over the term only
  const days = await daysOf(page, 'electricity-unit', 'You: 6M Winter Fix October 2025 v1');
  const on = days.filter(([, y]) => y != null).map(([d]) => d);
  expect([on[0], on.at(-1)]).toEqual(['2025-10-22', '2026-03-31']); // the 1-year window starts on 22 Oct 2025
});

test('the Ofgem price cap can be added; with no cap rates before 1 Jul 2026 it has no line and its row says so', async ({
  page,
}) => {
  await open(page);
  await setFrom(page, '2026-05-10');
  await page.selectOption('#add', 'cap');
  expect(await picked(page)).toEqual([FLEX, 'OE-FIX-12M-26-05-10', 'cap']);
  expect((await compareLines(page)).filter((l) => l.key === 'cap')).toEqual([]);
  await expect(page.locator('#totals li[data-key="cap"] .unranked')).toHaveText('no rates before 1 Jul 2026');
  await expect(page.locator('#totals li[data-key="cap"] .name')).toHaveText('Ofgem price cap (cap level)');
  await expect(page.locator('#totals li[data-key="cap"] .key.dash')).toHaveCount(1);
  await setFrom(page, '2026-07-01'); // from the cap's first day it is priced and drawn, dashed as elsewhere
  const lines = await compareLines(page);
  expect(lines.filter((l) => l.key === 'cap').map((l) => l.dash)).toEqual([
    [6, 4],
    [3, 3],
  ]);
  const cap = costFrom('cap', '2026-07-01');
  expect(at(lines, 'cap', 'past', CUTOFF)).toBeCloseTo(cap, 2);
  await expect(page.locator('#totals li[data-key="cap"] .figures')).toHaveText(
    `so far ${gbp(cap)} · in a year ${gbp(sum(dailyOf('cap', '2026-07-01')))}`,
  );
});

test('an empty gas field removes gas from every figure: the running totals, today’s rates and the exit fee', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  await page.fill('#kwh-gas', '');
  const elec = usage(false);
  await expect(page.locator('#mine-line')).toHaveText(
    `Fixed until 15 Jan 2027 · about ${gbp(yearNow('OE-FIX-12M-26-01-15', elec))}/yr · £75 to leave early.`,
  );
  const lines = await compareLines(page);
  const want = {
    'OE-FIX-12M-26-01-15': dailyOf('OE-FIX-12M-26-01-15', '2026-01-15', { kwh: elec, termEnd: '2027-01-15' }),
    [FLEX]: dailyOf(FLEX, '2026-01-15', { kwh: elec }),
  };
  for (const [key, days] of Object.entries(want)) {
    expect(at(lines, key, 'past', CUTOFF)).toBeCloseTo(costFrom(key, '2026-01-15', elec), 2);
    expect(at(lines, key, 'future', END)).toBeCloseTo(sum(days), 2);
  }
  expect(await totals(page)).toEqual(
    Object.entries(want).map(([k, days]) => [
      k,
      `so far ${gbp(costFrom(k, '2026-01-15', elec))} · in a year ${gbp(sum(days))}`,
    ]),
  );
});

test('one picked tariff draws its line alone, with no error text', async ({ page }) => {
  const errors = await open(page);
  await page.click(`#picked .chip[data-key="${FLEX}"]`);
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-05-10']);
  expect((await compareLines(page)).map((l) => [l.key, l.part])).toEqual([
    ['OE-FIX-12M-26-05-10', 'past'],
    ['OE-FIX-12M-26-05-10', 'future'],
  ]);
  await expect(page.locator('#lead')).toContainText('From 20 Oct 2026: solid');
  await expect(page.locator('#totals li')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('adding and removing tariffs redraws the chart and the totals, in pick order', async ({ page }) => {
  await open(page);
  await setFrom(page, '2026-05-10');
  await page.selectOption('#add', 'OE-FIX-12M-26-01-15');
  await page.selectOption('#add', 'VAR-25-01-01');
  const picks = [FLEX, 'OE-FIX-12M-26-05-10', 'OE-FIX-12M-26-01-15', 'VAR-25-01-01'];
  expect(await picked(page)).toEqual(picks);
  const check = async (keys) => {
    const lines = await compareLines(page);
    expect([...new Set(lines.map((l) => l.key))]).toEqual(keys);
    const rows = await totals(page);
    expect(rows.map(([k]) => k)).toEqual(keys);
    for (const k of keys) expect(at(lines, k, 'past', CUTOFF)).toBeCloseTo(costFrom(k, '2026-05-10'), 2);
    for (const [k, text] of rows) expect(text, k).toMatch(new RegExp(`^so far ${gbp(costFrom(k, '2026-05-10'))} · `));
  };
  await check(picks);
  await page.click('#picked .chip[data-key="OE-FIX-12M-26-05-10"]');
  await check([FLEX, 'OE-FIX-12M-26-01-15', 'VAR-25-01-01']);
});

test('choosing my tariff picks it first, sets the date to its since-date and draws the compare-from line', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-01-15', 'VAR-25-12-15']);
  await expect(page.locator('#from')).toHaveValue('2026-01-15');
  await expect(page.locator('#since')).toHaveValue('2026-01-15');
  await expect(page.locator('#lead')).toContainText('From 15 Jan 2026:');
  await expect(page.locator('#mine-line')).toHaveText(
    `Fixed until 15 Jan 2027 · about ${gbp(yearNow('OE-FIX-12M-26-01-15'))}/yr · £150 to leave early.`,
  );
  await expect(page.locator('#totals li[data-key="OE-FIX-12M-26-01-15"] .you-tag')).toHaveCount(1);
  await view(page, 'annual');
  await expect
    .poll(() =>
      page.evaluate((ids) => ids.map((id) => [__charts[id].$compareFrom, __charts[id].$compareLabel]), CHARTS),
    )
    .toEqual([...CHARTS.slice(0, 4).map(() => ['2026-01-15', false]), ['2026-01-15', true]]);
  await page.fill('#since', '2026-02-01'); // a later since-date moves the comparison with it, and is remembered
  await page.locator('#since').dispatchEvent('change');
  await expect(page.locator('#from')).toHaveValue('2026-02-01');
  await page.reload();
  await page.waitForSelector('body[data-ready]', { state: 'attached' });
  await expect(page.locator('#mine')).toHaveValue('OE-FIX-12M-26-01-15');
  await expect(page.locator('#from')).toHaveValue('2026-02-01');
  await expect(page.locator('#mine-line')).toContainText('Fixed until 1 Feb 2027');
});

test('clicking a family line sets the comparison date to that version’s launch', async ({ page }) => {
  await open(page);
  await view(page, 'annual');
  await frames(page);
  const { x, y } = await page.evaluate(() => {
    const c = __charts.annual;
    const ds = c.data.datasets.findIndex((d) => d.label === '12M Fixed');
    const i = c.data.datasets[ds].data.findIndex((p) => p.x === Date.parse('2026-02-15T00:00:00Z'));
    const pt = c.getDatasetMeta(ds).data[i];
    const box = c.canvas.getBoundingClientRect();
    return { x: box.left + pt.x + 2, y: box.top + pt.y };
  });
  await page.mouse.click(x, y); // 12M Fixed January 2026 v1 was on sale that day
  await expect(page.locator('#from')).toHaveValue('2026-01-15');
  await expect(page.locator('#lead')).toContainText('From 15 Jan 2026');
});

test.describe('phone 390x844, four tariffs picked', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('no horizontal overflow; the chart and every totals row fit, nothing clipped', async ({ page }) => {
    await open(page);
    await page.selectOption('#add', 'cap');
    await page.selectOption('#add', 'OE-FIX-12M-26-01-15');
    expect(await picked(page)).toHaveLength(4);
    expect(await noOverflow(page)).toBe(true);
    await expect(page.locator('#c-compare')).toBeVisible();
    await expect(page.locator('#totals li')).toHaveCount(4);
    const clipped = await page
      .locator('#totals li')
      .evaluateAll((ls) => ls.filter((l) => l.scrollWidth > l.clientWidth).map((l) => l.dataset.key));
    expect(clipped).toEqual([]);
    const box = await page.locator('#compare').boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});

test('the CSV links resolve under the prefix, one per family of the region', async ({ page }) => {
  await open(page);
  const links = await page.locator('#csv a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(links).toEqual(['./data/_C/oe-fix-12m.csv', './data/_C/oe-fix-6m.csv', './data/_C/flexible.csv']);
  const got = await page.evaluate(
    (hrefs) =>
      Promise.all(
        hrefs.map(async (h) => {
          const r = await fetch(h);
          return [r.status, (await r.text()).split('\n')[0]];
        }),
      ),
    links,
  );
  for (const [status, head] of got) {
    expect(status).toBe(200);
    expect(head).toBe(
      'day,electricity_version,electricity_unit_rate,electricity_standing_charge,gas_version,gas_unit_rate,gas_standing_charge',
    );
  }
});

// ---- review fixes for the comparison ----
test('after a region fails to load, the tariff and comparison controls are off and the comparison hidden', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-05-10');
  await page.route('**/data/_G/*.json', (route) => route.fulfill({ status: 500 }));
  await page.selectOption('#region', '_G');
  await expect(page.locator('#load-error')).toHaveText('Could not load data for North West');
  for (const id of ['#mine', '#since', '#add', '#from']) await expect(page.locator(id)).toBeDisabled();
  await expect(page.locator('#compare')).toBeHidden();
  await expect(page.locator('#mine-line')).toBeHidden();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluate(() => {
    for (const id of ['mine', 'since', 'add', 'from']) document.getElementById(id).dispatchEvent(new Event('change'));
  });
  await frames(page);
  expect(errors).toEqual([]);
});

test('a rate missing today leaves the projection blank, not £0, and marks every switch row on its own', async ({
  page,
}) => {
  // London's Flexible with no rate on the cutoff day: a fix's roll-on and every projection have nothing to price
  await page.route('**/data/_C/flexible.json', async (route) => {
    const file = await (await route.fetch()).json();
    for (const rows of [file.electricity.days, file.electricity.versions[FLEX].days])
      for (const p of rows) if (p.day === CUTOFF) Object.assign(p, { unit: null, standingCharge: null });
    await route.fulfill({ json: file });
  });
  await open(page);
  await page.selectOption('#mine', MINE_FIX);
  await expect(page.locator(`#totals li[data-key="${MINE_FIX}"] .figures`)).toHaveText(
    /^so far £[\d,]+ · in a year –$/,
  );
  await page.click('#cmode button[data-v="switch"]');
  await expect(page.locator('#totals li')).toHaveCount(2);
  for (const key of [MINE_FIX, FLEX])
    await expect(page.locator(`#totals li[data-key="${key}"] .unranked`)).toHaveText('no rates today');
});

test('unpriced days are named by where they sit: a gap inside the span, or no rates after the last priced day', async ({
  page,
}) => {
  // London's cap with August missing: priced in July and again from September.
  await page.route('**/data/_C/cap.json', async (route) => {
    const file = await (await route.fetch()).json();
    for (const p of file.electricity.days)
      if (p.day.startsWith('2026-08')) Object.assign(p, { unit: null, standingCharge: null });
    await route.fulfill({ json: file });
  });
  await open(page);
  await page.selectOption('#add', 'cap');
  await page.fill('#from', '2026-07-01');
  await page.locator('#from').dispatchEvent('change');
  await expect(page.locator('#totals li[data-key="cap"] .unranked')).toHaveText('no rates 1 Aug 2026 – 31 Aug 2026');
  // North West's cap stops after September (no row for the October period).
  await page.selectOption('#region', '_G');
  await expect(page.locator('#footer')).toContainText('· North West ·');
  await page.selectOption('#add', 'cap');
  await page.fill('#from', '2026-07-01');
  await page.locator('#from').dispatchEvent('change');
  await expect(page.locator('#totals li[data-key="cap"] .unranked')).toHaveText('no rates after 30 Sept 2026');
});

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
]) {
  test.describe(name, () => {
    test.use({ viewport });
    test('the date inputs show the whole date', async ({ page }) => {
      await open(page);
      await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
      await page.click('#cmode button[data-v="switch"]'); // the switch date shows only in "if I switch"
      expect(await noOverflow(page)).toBe(true);
      const clipped = await page.evaluate(() =>
        // narrower than its own intrinsic width (the whole date plus the calendar button) means clipped
        ['since', 'from', 'switch'].filter((id) => {
          const i = document.getElementById(id);
          const shown = i.getBoundingClientRect().width;
          const set = i.style.width;
          i.style.width = 'auto';
          const natural = i.getBoundingClientRect().width;
          i.style.width = set;
          return shown + 0.5 < natural;
        }),
      );
      expect(clipped).toEqual([]);
    });
  });
}

test('a click on blank plot area leaves the comparison date alone', async ({ page }) => {
  await open(page);
  await view(page, 'annual');
  await frames(page);
  const { x, y } = await page.evaluate(() => {
    const c = __charts.annual;
    const box = c.canvas.getBoundingClientRect();
    return {
      x: box.left + c.scales.x.getPixelForValue(Date.parse('2026-02-15T12:00:00Z')),
      y: box.top + c.scales.y.getPixelForValue(500), // far below every line
    };
  });
  await page.mouse.click(x, y);
  await frames(page);
  await expect(page.locator('#from')).toHaveValue('2026-10-20');
});

test('switching region resets the comparison to that region’s defaults', async ({ page }) => {
  await open(page);
  await page.selectOption('#add', 'cap');
  await page.fill('#from', '2026-03-01');
  await page.locator('#from').dispatchEvent('change');
  await page.selectOption('#region', '_G');
  await expect(page.locator('#footer')).toContainText('· North West ·');
  expect(await picked(page)).toEqual(['VAR-25-12-15', 'OE-FIX-12M-26-01-15']); // 12M May 2026 is not sold there
  await expect(page.locator('#from')).toHaveValue('2026-10-20');
});

test('a variable tariff of mine reads "Variable · about £X/yr · no exit fee."', async ({ page }) => {
  await open(page);
  await page.selectOption('#mine', 'VAR-25-12-15');
  await expect(page.locator('#mine-line')).toHaveText(
    `Variable · about ${gbp(yearNow('VAR-25-12-15'))}/yr · no exit fee.`,
  );
  // it is the Flexible head itself, so the latest launch, 12M May 2026, is the second pick
  expect(await picked(page)).toEqual(['VAR-25-12-15', 'OE-FIX-12M-26-05-10']);
});

test('a remembered tariff not sold in the region shows none, stays remembered, and returns in its region', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('octopus-tariffs:mine', JSON.stringify({ code: 'OE-FIX-12M-26-05-10', since: null })),
  );
  await open(page, '?region=_G');
  await expect(page.locator('#mine')).toHaveValue('');
  await expect(page.locator('#mine-line')).toBeHidden();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('octopus-tariffs:mine'))).code).toBe(
    'OE-FIX-12M-26-05-10',
  );
  await page.selectOption('#region', '_C');
  await expect(page.locator('#mine')).toHaveValue('OE-FIX-12M-26-05-10');
  expect((await picked(page))[0]).toBe('OE-FIX-12M-26-05-10');
});

// ---- the comparison anchored on my tariff, and the line of my tariff on every chart ----
const MINE = 'You: 12M January 2026 v1';
/** [day, y] of one line of one chart, one per day; null when the chart has no such line. */
const daysOf = (page, chart, label) =>
  page.evaluate(
    ([c, l]) =>
      __charts[c].data.datasets
        .find((d) => d.label === l)
        ?.data.filter((_, i) => i % 2 === 0)
        .map((p) => [new Date(p.x).toISOString().slice(0, 10), p.y]) ?? null,
    [chart, label],
  );
/** A version's own row on `day`, else its last own row, from the built file. */
const ownRow = (code, fuel, day) => {
  const [id] = Object.entries(FAMILY).find(([p]) => code.startsWith(p))[1];
  const own = builtFile('_C', id)[fuel].versions[code].days;
  return own.find((p) => p.day === day) ?? own.at(-1);
};
/** The value a chart's You line should have on `day` for a fixed version of mine, in its term [since, end). */
const mineWant = (code, chart, day) => {
  if (chart === 'annual')
    return Object.entries(usage()).reduce((sum, [fuel, k]) => sum + annualCost(ownRow(code, fuel, day), k), 0);
  const [fuel, field] = chart.split('-');
  return ownRow(code, fuel, day)[field === 'unit' ? 'unit' : 'standingCharge'];
};

test('my tariff draws a "You" line on every chart at its own rates from its since-date, with its own chip', async ({
  page,
}) => {
  await open(page);
  expect(await daysOf(page, 'electricity-unit', MINE)).toBeNull();
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  await view(page, 'annual');
  for (const chart of CHARTS) {
    const days = await daysOf(page, chart, MINE);
    expect(days.length).toBeGreaterThan(0);
    for (const [day, y] of days) {
      if (day < '2026-01-15') expect(y, `${chart} ${day}`).toBeNull();
      else expect(y, `${chart} ${day}`).toBeCloseTo(mineWant('OE-FIX-12M-26-01-15', chart, day), 6);
    }
  }
  const mine = await page.evaluate(() => {
    const d = __charts['electricity-unit'].data.datasets.at(-1);
    return { lineId: d.lineId, width: d.borderWidth, order: d.order, hidden: d.hidden };
  });
  expect(mine).toEqual({ lineId: 'mine', width: 3, order: -1, hidden: false });
  await expect(page.locator('#chips .chip')).toHaveCount(5); // the cap, the three families, then mine
  // a later since-date starts the line there
  await page.fill('#since', '2026-02-01');
  await page.locator('#since').dispatchEvent('change');
  const days = await daysOf(page, 'gas-unit', MINE);
  expect(days.find(([, y]) => y != null)[0]).toBe('2026-02-01');
});

test('the legend keys the price cap changes always, and my tariff with a last chip once picked', async ({ page }) => {
  await open(page);
  await expect(page.locator('#legend-cap')).toBeVisible();
  await expect(page.locator('#legend-cap a.term')).toHaveText('price cap change');
  await expect(page.locator('#legend-cap a.term')).toHaveAttribute('href', '#fn-cap');
  const you = page.locator('#chips .chip[data-line="mine"]');
  await expect(you).toHaveCount(0);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  await expect(page.locator('#chips .chip').last()).toHaveAttribute('data-line', 'mine');
  await expect(you.locator('b')).toHaveText(MINE);
  await expect(you.locator('small')).toHaveText(`about ${gbp(yearNow('OE-FIX-12M-26-01-15'))}/yr`);
  await expect(you).toHaveAttribute('aria-pressed', 'true');
  await page.selectOption('#mine', '');
  await expect(you).toHaveCount(0);
});

test('the You line is drawn in the ink of the current scheme, redrawn when the scheme changes', async ({ page }) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  const colours = () =>
    page.evaluate((label) => {
      const i = document.body.appendChild(document.createElement('i'));
      i.style.color = 'var(--text)';
      const text = getComputedStyle(i).color;
      i.remove();
      return [text, __charts['electricity-unit'].data.datasets.find((d) => d.label === label).borderColor];
    }, MINE);
  expect(await colours()).toEqual(['rgb(11, 11, 11)', 'rgb(11, 11, 11)']);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(colours).toEqual(['rgb(240, 239, 236)', 'rgb(240, 239, 236)']);
});

// ---- if I switch: from the switch date, the exit fee plus each pick's cost against staying put ----
const MINE_FIX = 'OE-FIX-12M-26-01-15'; // since its launch, 15 Jan 2026: term to 15 Jan 2027, £75 exit fee per fuel
const fmtDay = (day) =>
  new Date(Date.parse(`${day}T00:00:00Z`)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const addDaysTo = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const switchMode = (page) => page.click('#cmode button[data-v="switch"]');
const setSwitch = async (page, day) => {
  await page.fill('#switch', day);
  await page.locator('#switch').dispatchEvent('change');
};
/** The y of every point of `key`'s line in switch mode, one per day start from the switch date to END. */
const switchYs = async (page, key) => {
  const line = (await compareLines(page)).find((l) => l.key === key);
  return line.points;
};
/** The totals text of a pick against staying put: paid back from the day the running £ is last above 0, and its year. */
const switchText = (fee, move, stay, s) => {
  const ys = [fee];
  for (const [i, m] of move.entries()) ys.push(ys[i] + m - stay[i]);
  const y = ys.at(-1);
  if (Math.abs(y) < 1) return '£0 in a year';
  const lastAbove = ys.findLastIndex((v) => v > 0);
  if (lastAbove === ys.length - 1) return `doesn't pay back within a year · ${gbp(y)} behind`;
  return `pays back ${fmtDay(addDaysTo(s, Math.max(lastAbove, 0)))} · ${gbp(-y)} ahead in a year`;
};
/** Each step of a line's points against the expected daily difference. */
const expectSteps = (points, move, stay) => {
  expect(points).toHaveLength(move.length + 1);
  for (let i = 0; i < move.length; i++)
    expect(points[i + 1][1] - points[i][1], points[i][0]).toBeCloseTo(move[i] - stay[i], 6);
};

test('if I switch: my tariff is flat at zero from the switch date; Flexible starts at the exit fee and adds its daily difference', async ({
  page,
}) => {
  const errors = await open(page);
  await page.selectOption('#mine', MINE_FIX);
  await switchMode(page);
  await expect(page.locator('#switch')).toHaveValue(CUTOFF);
  const lines = await compareLines(page);
  expect(lines.map((l) => [l.key, l.part, l.dash])).toEqual([
    [MINE_FIX, 'future', [3, 3]],
    [FLEX, 'future', [3, 3]],
  ]);
  const mine = lines[0].points;
  expect([mine[0][0], mine.at(-1)[0]]).toEqual([CUTOFF, END]);
  for (const [day, y] of mine) expect(y, day).toBe(0);
  const stay = dailyOf(MINE_FIX, CUTOFF, { termEnd: '2027-01-15' });
  const move = dailyOf(FLEX, CUTOFF);
  const flex = lines[1].points;
  expect(flex[0][0]).toBe(CUTOFF);
  expect(flex[0][1]).toBeCloseTo(150, 2);
  expectSteps(flex, move, stay);
  expect(await page.evaluate(() => [__charts.compare.scales.x.min, __charts.compare.scales.x.max])).toEqual([
    Date.parse(`${CUTOFF}T00:00:00Z`),
    Date.parse(`${END}T00:00:00Z`),
  ]);
  expect(await totals(page)).toEqual([
    [MINE_FIX, 'stay · exit fee £150 until 27 Nov 2026'],
    [FLEX, switchText(150, move, stay, CUTOFF)],
  ]);
  expect(switchText(150, move, stay, CUTOFF)).toMatch(/^doesn't pay back within a year · £\d+ behind$/);
  await expect(page.locator(`#totals li[data-key="${FLEX}"] .delta.up`)).toHaveCount(1);
  await expect(page.locator(`#totals li[data-key="${MINE_FIX}"] .you-tag`)).toHaveText('you');
  // the tooltip of the first day: the day as its title, mine as "you", Flexible signed
  const tipped = await page.evaluate(() => {
    const c = __charts.compare;
    const active = c.data.datasets.map((_, datasetIndex) => ({ datasetIndex, index: 1 }));
    c.tooltip.setActiveElements(active, { x: 0, y: 0 });
    c.update('none');
    return { title: c.tooltip.title, body: c.tooltip.body.flatMap((b) => b.lines) };
  });
  const first = 150 + move[0] - stay[0];
  expect(tipped).toEqual({
    title: [fmtDay(CUTOFF)],
    body: [
      '12M January 2026 v1 · you',
      `Flexible Octopus December 2025 v2 · ${first < 0 ? '−' : '+'}${gbp(Math.abs(first))}`,
    ],
  });
  // a dearer fix of mine: Flexible pays back once its savings cover the fee, and reads ahead in green
  const dear = 'OE-FIX-12M-26-05-10'; // since 10 May 2026: term to 10 May 2027, fee-free from 22 Mar 2027
  await page.selectOption('#mine', dear);
  const [move2, stay2] = [dailyOf(FLEX, CUTOFF), dailyOf(dear, CUTOFF, { termEnd: '2027-05-10' })];
  const text = switchText(150, move2, stay2, CUTOFF);
  expect(text).toMatch(/^pays back \d+ \w+ 2027 · £\d+ ahead in a year$/);
  expect(await totals(page)).toEqual([
    [dear, 'stay · exit fee £150 until 22 Mar 2027'],
    [FLEX, text],
  ]);
  await expect(page.locator(`#totals li[data-key="${FLEX}"] .delta.down`)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('if I switch: no exit fee from 49 days before my term ends; a switch date before that pays it', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', MINE_FIX);
  await switchMode(page);
  const row = page.locator(`#totals li[data-key="${MINE_FIX}"] .figures`);
  for (const [day, fee] of [
    ['2026-12-01', 0],
    ['2026-11-27', 0], // 49 days before 15 Jan 2027: the first fee-free day
    ['2026-11-26', 150],
    ['2026-11-01', 150],
  ]) {
    await setSwitch(page, day);
    await expect(row).toHaveText(fee ? 'stay · exit fee £150 until 27 Nov 2026' : 'stay · no exit fee');
    const flex = await switchYs(page, FLEX);
    expect(flex[0][0]).toBe(day);
    expect(flex[0][1], day).toBeCloseTo(fee, 2);
    expectSteps(flex, dailyOf(FLEX, day), dailyOf(MINE_FIX, day, { termEnd: '2027-01-15' }));
  }
  // a switch date after the cutoff draws a "switch" vertical; the line starts there, the x axis still at today
  expect(await page.evaluate(() => __charts.compare.$switchAt)).toBe('2026-11-01');
  expect(await page.evaluate(() => __charts.compare.scales.x.min)).toBe(Date.parse(`${CUTOFF}T00:00:00Z`));
});

test('if I switch with an empty gas field: the exit fee is the electricity one', async ({ page }) => {
  await open(page);
  await page.selectOption('#mine', MINE_FIX);
  await page.fill('#kwh-gas', '');
  await switchMode(page);
  const elec = usage(false);
  const flex = await switchYs(page, FLEX);
  expect(flex[0][1]).toBeCloseTo(75, 2);
  const [move, stay] = [
    dailyOf(FLEX, CUTOFF, { kwh: elec }),
    dailyOf(MINE_FIX, CUTOFF, { kwh: elec, termEnd: '2027-01-15' }),
  ];
  expectSteps(flex, move, stay);
  expect(await totals(page)).toEqual([
    [MINE_FIX, 'stay · exit fee £75 until 27 Nov 2026'],
    [FLEX, switchText(75, move, stay, CUTOFF)],
  ]);
});

test('if I switch with no tariff of mine: Flexible is the anchor with no exit fee, a fix its daily difference from 0', async ({
  page,
}) => {
  await open(page);
  await switchMode(page);
  const fix = 'OE-FIX-12M-26-05-10';
  expect(await picked(page)).toEqual([FLEX, fix]);
  const lines = await compareLines(page);
  for (const [, y] of lines.find((l) => l.key === FLEX).points) expect(y).toBe(0);
  const points = lines.find((l) => l.key === fix).points;
  expect(points[0]).toEqual([CUTOFF, 0]);
  const [move, stay] = [dailyOf(fix, CUTOFF), dailyOf(FLEX, CUTOFF)];
  expectSteps(points, move, stay);
  expect(await totals(page)).toEqual([
    [FLEX, 'stay · no exit fee'],
    [fix, switchText(0, move, stay, CUTOFF)],
  ]);
});

test('if I switch from a fixed term that has ended: no exit fee, and Flexible costs the same as staying', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-6M-25-10-01');
  await switchMode(page);
  await expect(page.locator('#totals li[data-key="OE-FIX-6M-25-10-01"] .figures')).toHaveText('stay · no exit fee');
  const flex = await switchYs(page, FLEX);
  expect(flex[0]).toEqual([CUTOFF, 0]);
  for (const [day, y] of flex) expect(y, day).toBeCloseTo(0, 6);
  await expect(page.locator(`#totals li[data-key="${FLEX}"] .figures`)).toHaveText('£0 in a year');
});

test('the if-I-switch controls: the switch date only in that mode, the from date off in it, its own lead', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', MINE_FIX);
  await expect(page.locator('#cmode button')).toHaveText(['£ paid', 'vs yours', 'if I switch']);
  for (const mode of ['paid', 'vs']) {
    await page.click(`#cmode button[data-v="${mode}"]`);
    await expect(page.locator('#switch-field')).toBeHidden();
    await expect(page.locator('#from')).toBeEnabled();
  }
  await switchMode(page);
  await expect(page.locator('#cmode button[data-v="switch"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#switch-field')).toBeVisible();
  await expect(page.locator('#from')).toBeDisabled();
  expect(await page.locator('#switch').evaluate((i) => [i.min, i.max])).toEqual([CUTOFF, '2027-10-20']);
  await expect(page.locator('#lead')).toHaveText(
    "If you switch on 21 Oct 2026: exit fee once, then the new tariff's rates; the line crosses £0 when it has paid back.",
  );
  await expect(page.locator('#lead a.term')).toHaveCount(2); // the mode and the exit fee, each at its definition
  await expect(page.locator('#lead a.term').first()).toHaveAttribute('href', '#fn-switch');
  await expect(page.locator('#lead a.term').last()).toHaveAttribute('href', '#fn-exitfee');
  await expect(page.locator('#lead a.term').last()).toHaveText('exit fee');
  await setSwitch(page, '2026-12-01');
  await expect(page.locator('#lead b')).toHaveText('1 Dec 2026');
  await page.click('#cmode button[data-v="vs"]');
  await expect(page.locator('#switch-field')).toBeHidden();
});

test('back from if I switch to £ paid, the chart runs from the date again', async ({ page }) => {
  await open(page);
  await switchMode(page);
  await page.click('#cmode button[data-v="paid"]');
  await expect(page.locator('#from')).toBeEnabled();
  await expect(page.locator('#lead')).toContainText('From 20 Oct 2026: solid');
  const lines = await compareLines(page);
  expect(lines.map((l) => [l.key, l.part])).toEqual([
    [FLEX, 'past'],
    [FLEX, 'future'],
    ['OE-FIX-12M-26-05-10', 'past'],
    ['OE-FIX-12M-26-05-10', 'future'],
  ]);
  for (const key of [FLEX, 'OE-FIX-12M-26-05-10']) {
    expect(lines.find((l) => l.key === key && l.part === 'past').points[0]).toEqual(['2026-10-20', 0]);
    expect(at(lines, key, 'past', CUTOFF)).toBeCloseTo(costFrom(key, '2026-10-20'), 2);
  }
  expect(await totals(page)).toEqual(
    [FLEX, 'OE-FIX-12M-26-05-10'].map((k) => [
      k,
      `so far ${gbp(costFrom(k, '2026-10-20'))} · in a year ${gbp(sum(dailyOf(k, '2026-10-20', k === FLEX ? {} : { termEnd: '2027-10-20' })))}`,
    ]),
  );
  expect(await page.evaluate(() => __charts.compare.scales.y.min)).toBe(0);
});
