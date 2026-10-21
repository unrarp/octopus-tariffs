import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from '../src/build.js';
import { annualAt, capSeries, costSince, versionSeries } from '../src/site/lib/compare.js';

const ROOT = fileURLToPath(new URL('./fixtures/build', import.meta.url));
const BUILT = new Date('2026-10-21T06:00:00.000Z'); // the fixture's collection time, the build's generatedAt
const NOW = Date.parse('2026-10-21T12:00:00.000Z'); // the viewer's clock: same day, so nothing is hatched
const DAY = 86_400_000;
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
  await expect(page.locator('#usage-hint')).toHaveText('typical home (Ofgem); your bill shows your own kWh');
  const before = (await values(page, 'annual', 'Flexible Octopus')).at(-1);
  const chip = page.locator('.chip[data-line="flexible"] small');
  const chipBefore = await chip.textContent();
  expect(chipBefore).toMatch(/^about £[\d,]+\/yr$/);
  await page.fill('#kwh-electricity', '3500');
  const after = (await values(page, 'annual', 'Flexible Octopus')).at(-1);
  expect(after - before).toBeCloseTo(1000 * 0.266, 6); // 1,000 kWh more at 26.6 p/kWh (0 % VAT on electricity from 2026-10-01)
  await expect(chip).not.toHaveText(chipBefore);
  await expect(page.locator('#usage-hint')).toHaveText('your usage');
  await page.fill('#kwh-gas', '');
  const elecOnly = (await values(page, 'annual', 'Flexible Octopus')).at(-1);
  expect(elecOnly).toBeCloseTo((26.6 * 3500 + 41.4 * 365) / 100, 6);
  await view(page, 'rates');
  await expect(page.locator('#t-gas-unit')).toContainText('no gas supply');
  await view(page, 'annual');
  await page.click('#per button[data-v="month"]');
  expect((await values(page, 'annual', 'Flexible Octopus')).at(-1)).toBeCloseTo(elecOnly / 12, 6);
  await expect(chip).toHaveText(/^about £[\d,]+\/month$/);
  await expect(page.locator('#note')).toContainText('Estimated monthly cost');
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

test('a chip hides its line on every chart and shows it again', async ({ page }) => {
  await open(page);
  const visible = () => page.evaluate((ids) => ids.map((id) => __charts[id].isDatasetVisible(3)), CHARTS); // dataset 3: Flexible
  expect(await visible()).toEqual([true, true, true, true, true]);
  await page.click('.chip[data-line="flexible"]');
  await expect(page.locator('.chip[data-line="flexible"]')).toHaveAttribute('aria-pressed', 'false');
  expect(await visible()).toEqual([false, false, false, false, false]);
  await page.click('.chip[data-line="flexible"]');
  expect(await visible()).toEqual([true, true, true, true, true]);
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
  expect(await tip(page)).toEqual({ opacity: 1, title: ['10 May 2026'], body: ['12M Fixed – 29.4'] });
  await page.evaluate(() => {
    location.hash = '#2026-08-01';
  });
  await expect.poll(async () => (await tip(page)).title).toEqual(['1 Aug 2026']);
  expect((await tip(page)).body).toEqual([
    'Ofgem price cap, London – 25.7',
    '12M Fixed – 29.4',
    'Flexible Octopus – 27.8',
  ]);
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

test('usage is remembered: a reload restores it with the "your usage" hint', async ({ page }) => {
  await open(page);
  await page.fill('#kwh-electricity', '3000');
  await page.fill('#kwh-gas', '');
  await page.reload();
  await page.waitForSelector('body[data-ready]', { state: 'attached' });
  await expect(page.locator('#kwh-electricity')).toHaveValue('3000');
  await expect(page.locator('#kwh-gas')).toHaveValue('');
  await expect(page.locator('#usage-hint')).toHaveText('your usage');
  await expect(page.locator('#t-gas-unit')).toContainText('no gas supply');
});

test('"Not yet collected" hatches the days after generatedAt up to the viewer’s today', async ({ page }) => {
  await open(page, '', { at: NOW + 4 * DAY });
  const { width, perDay } = await page.evaluate(() => {
    const c = __charts['electricity-unit'];
    return { width: c.$hatch.width, perDay: c.scales.x.getPixelForValue(86_400_000) - c.scales.x.getPixelForValue(0) };
  });
  expect(Math.abs(width - 4 * perDay)).toBeLessThan(1);
  await expect(page.locator('#legend-hatch')).toBeVisible();
});

test('the (i) dialog lists every definition; a term link opens it at its entry', async ({ page }) => {
  await open(page);
  await page.click('#info');
  await expect(page.locator('#help')).toBeVisible();
  await expect(page.locator('#fn-cap')).toContainText("Ofgem's default tariff cap");
  await expect(page.locator('#fn-tdcv')).toContainText('revised on 1 July 2026');
  await page.click('#help-close');
  await page.click('#note a.term[href="#fn-cap"]');
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

// ---- the comparison (PLAN.md Step 3.2): expected £ figures come from the same lib on the same built files ----
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
const costFrom = (code, from, kwh = usage()) =>
  Object.entries(kwh).reduce((sum, [fuel, k]) => sum + costSince(seriesOf(code, fuel), from, CUTOFF, fuel, k).cost, 0);
const yearNow = (code, kwh = usage()) =>
  Object.entries(kwh).reduce((sum, [fuel, k]) => sum + annualAt(seriesOf(code, fuel), CUTOFF, k), 0);
const gbp = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;
const picked = (page) => page.locator('#picked .chip').evaluateAll((cs) => cs.map((c) => c.dataset.key));
/** The ranked bars in page order: [key, total text]. */
const totals = (page) =>
  page.locator('#bars .total').evaluateAll((ts) => ts.map((t) => [t.dataset.key, t.querySelector('b').textContent]));

test('the comparison runs from the default date to generatedAt’s day, cheapest first', async ({ page }) => {
  await open(page);
  // No tariff of mine and no OE-FIX-18M-26-09-11 in the fixture: side A is the latest launch, 12M May 2026, then Flexible.
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-05-10', 'VAR-25-12-15']);
  await expect(page.locator('#from')).toHaveValue('2026-05-10');
  await expect(page.locator('#lead')).toHaveText('From 10 May 2026 to today (164 days), cheapest first:');
  const want = ['OE-FIX-12M-26-05-10', 'VAR-25-12-15']
    .map((c) => [c, costFrom(c, '2026-05-10')])
    .sort((a, b) => a[1] - b[1])
    .map(([c, v]) => [c, `about ${gbp(v)}`]);
  expect(await totals(page)).toEqual(want);
  await expect(page.locator('#forward')).toHaveText(
    `If today's rates stayed the same: 12M May 2026 v1 (fixed 12M) about ${gbp(yearNow('OE-FIX-12M-26-05-10'))}/yr · ` +
      `Flexible Octopus December 2025 v2 (variable) about ${gbp(yearNow('VAR-25-12-15'))}/yr. A variable tariff's rates move with the price cap.`,
  );
  await expect(page.locator('#compare-hint')).toHaveText(
    "Estimates, not bills. Your usage follows a typical home's seasonal pattern; standing charge and VAT included; direct debit. Each tariff is costed at its own rates from the date, on sale then or not. Exit fees, service and brand ignored.",
  );
});

test('choosing my tariff picks it first, sets the date to its since-date and draws the compare-from line', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-01-15', 'VAR-25-12-15']);
  await expect(page.locator('#from')).toHaveValue('2026-01-15');
  await expect(page.locator('#since')).toHaveValue('2026-01-15');
  await expect(page.locator('#lead')).toContainText('From 15 Jan 2026 to today (279 days)');
  await expect(page.locator('#mine-line')).toHaveText(
    `Fixed until 15 Jan 2027 · about ${gbp(yearNow('OE-FIX-12M-26-01-15'))}/yr · £150 to leave early.`,
  );
  await expect(page.locator('#bars .you-tag')).toHaveCount(1);
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

test('an empty gas field removes gas from every figure: totals, today’s rates and the exit fee', async ({ page }) => {
  await open(page);
  await page.selectOption('#mine', 'OE-FIX-12M-26-01-15');
  await page.fill('#kwh-gas', '');
  const elec = usage(false);
  await expect(page.locator('#mine-line')).toHaveText(
    `Fixed until 15 Jan 2027 · about ${gbp(yearNow('OE-FIX-12M-26-01-15', elec))}/yr · £75 to leave early.`,
  );
  const want = ['OE-FIX-12M-26-01-15', 'VAR-25-12-15']
    .map((c) => [c, costFrom(c, '2026-01-15', elec)])
    .sort((a, b) => a[1] - b[1])
    .map(([c, v]) => [c, `about ${gbp(v)}`]);
  expect(await totals(page)).toEqual(want);
  await expect(page.locator('#forward')).toContainText(
    `Flexible Octopus December 2025 v2 (variable) about ${gbp(yearNow('VAR-25-12-15', elec))}/yr`,
  );
});

test('fewer than two picked tariffs reads "Add at least two tariffs."', async ({ page }) => {
  await open(page);
  await page.click('#picked .chip[data-key="VAR-25-12-15"]');
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-05-10']);
  await expect(page.locator('#lead')).toHaveText('Add at least two tariffs.');
  await expect(page.locator('#bars > *')).toHaveCount(0);
  await expect(page.locator('#forward')).toHaveText('');
});

test('the Ofgem price cap can be added; with no cap rates before 1 Jul 2026 it is listed unranked', async ({
  page,
}) => {
  await open(page);
  await page.selectOption('#add', 'cap');
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-05-10', 'VAR-25-12-15', 'cap']);
  await expect(page.locator('#bars .unranked[data-key="cap"]')).toHaveText('no rates before 1 Jul 2026');
  await expect(page.locator('#bars .name').last()).toHaveText('Ofgem price cap (cap level)');
  await expect(page.locator('#forward')).toContainText(`Ofgem price cap (cap level) about ${gbp(yearNow('cap'))}/yr`);
  await page.fill('#from', '2026-07-01'); // from the cap's first day it is priced and ranked
  await page.locator('#from').dispatchEvent('change');
  await expect(page.locator('#bars .total[data-key="cap"]')).toHaveText(`about ${gbp(costFrom('cap', '2026-07-01'))}`);
});

test('adding and removing tariffs recomputes the bars and keeps them cheapest first', async ({ page }) => {
  await open(page);
  const ranked = async () => {
    const t = await totals(page);
    const want = t.map(([c]) => [c, costFrom(c, '2026-05-10')]).sort((a, b) => a[1] - b[1]);
    expect(t).toEqual(want.map(([c, v]) => [c, `about ${gbp(v)}`])); // every total right, in cheapest-first order
    return t.map(([c]) => c);
  };
  expect(await ranked()).toHaveLength(2);
  await page.selectOption('#add', 'OE-FIX-12M-26-01-15');
  await page.selectOption('#add', 'VAR-25-01-01');
  expect((await ranked()).sort()).toEqual([
    'OE-FIX-12M-26-01-15',
    'OE-FIX-12M-26-05-10',
    'VAR-25-01-01',
    'VAR-25-12-15',
  ]);
  await expect(page.locator('#bars .delta')).toHaveCount(3); // "+£n" against the cheapest on all but the cheapest
  await page.click('#picked .chip[data-key="OE-FIX-12M-26-05-10"]');
  expect((await ranked()).sort()).toEqual(['OE-FIX-12M-26-01-15', 'VAR-25-01-01', 'VAR-25-12-15']);
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
  test('no horizontal overflow; bars hidden, totals kept', async ({ page }) => {
    await open(page);
    await page.selectOption('#add', 'cap');
    await page.selectOption('#add', 'OE-FIX-12M-26-01-15');
    expect(await picked(page)).toHaveLength(4);
    expect(await noOverflow(page)).toBe(true);
    await expect(page.locator('#bars .bar').first()).toBeHidden();
    await expect(page.locator('#bars .total').first()).toBeVisible();
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
  await expect(page.locator('#bars .unranked[data-key="cap"]')).toHaveText('no rates 1 Aug 2026 – 31 Aug 2026');
  // North West's cap stops after September (no row for the October period).
  await page.selectOption('#region', '_G');
  await expect(page.locator('#footer')).toContainText('· North West ·');
  await page.selectOption('#add', 'cap');
  await page.fill('#from', '2026-07-01');
  await page.locator('#from').dispatchEvent('change');
  await expect(page.locator('#bars .unranked[data-key="cap"]')).toHaveText('no rates after 30 Sept 2026');
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
      const clipped = await page.evaluate(() =>
        // narrower than its own intrinsic width (the whole date plus the calendar button) means clipped
        ['since', 'from'].filter((id) => {
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
  await expect(page.locator('#from')).toHaveValue('2026-05-10');
});

test('switching region resets the comparison to that region’s defaults', async ({ page }) => {
  await open(page);
  await page.selectOption('#add', 'cap');
  await page.fill('#from', '2026-03-01');
  await page.locator('#from').dispatchEvent('change');
  await page.selectOption('#region', '_G');
  await expect(page.locator('#footer')).toContainText('· North West ·');
  expect(await picked(page)).toEqual(['OE-FIX-12M-26-01-15', 'VAR-25-12-15']); // 12M May 2026 is not sold there
  await expect(page.locator('#from')).toHaveValue('2026-01-15');
});

test('a variable tariff of mine reads "Variable · about £X/yr · no exit fee."', async ({ page }) => {
  await open(page);
  await page.selectOption('#mine', 'VAR-25-12-15');
  await expect(page.locator('#mine-line')).toHaveText(
    `Variable · about ${gbp(yearNow('VAR-25-12-15'))}/yr · no exit fee.`,
  );
  // it is the Flexible head itself, so the reference fix (here the latest launch, 12M May 2026) is the second pick
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

test('a one-day span reads "(1 day)"', async ({ page }) => {
  await open(page);
  await page.fill('#from', '2026-10-20');
  await page.locator('#from').dispatchEvent('change');
  await expect(page.locator('#lead')).toHaveText('From 20 Oct 2026 to today (1 day), cheapest first:');
});
