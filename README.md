# octopus-tariffs

How have Octopus Energy tariff prices moved over time, and would a fix or the
variable have been cheaper? <https://unrarp.github.io/octopus-tariffs/> charts
the unit rates and standing charges of Octopus's fixed and Flexible tariffs
against the Ofgem price cap, in every region, and costs any tariffs you pick
from a date of your choosing at your own usage.

A Claude Code routine collects daily and commits the result here; GitHub Pages
serves `docs/`.

## What the site shows

- **Rates** (default): stepped lines of electricity and gas unit rates and
  standing charges per family, with the Ofgem price cap drawn under them.
- **Annual cost**: estimated £ per year or month at your usage, dual fuel or
  electricity only.
- **Compare tariffs**: any number of tariffs costed from a date, cheapest first.
- A region select (remembered, else geolocated, else London) and a window
  control (6 months, 1 year, 2 years, all).

## How the data is made

```
families.json ─► src/collect.js ─► data/products/<code>.json          product detail
                                   data/rates/<tariffCode>/<rel>.csv  one CSV per rate endpoint, append-only
products + rates + families.json + cap.json + src/vat.js
        ─► src/build.js ─► docs/data/** + docs/index.html (+ hashed assets)
        ─► src/validate.js   shape and invariants
```

- **Collect** reads Octopus's public API (no auth) for every `OCTOPUS_ENERGY`
  product whose code matches `log.match` in `families.json`, and stores each
  product's detail and the full history of each rate endpoint it lists, for
  every region. Fixed products are collected too: a fixed rate can still step
  when a levy or VAT change passes through. `data/` and `docs/` (except
  `docs/vendor/`) are machine-written; never edit them by hand.
- **Build** derives everything else: family membership, sale windows, daily
  series, the comparison data. Nothing derived is stored in `data/`.
- **Inc VAT is derived, not copied.** The API prices a rate row that is still
  open at today's VAT rather than the period's, so the build takes
  `value_exc_vat` and applies the schedule in `src/vat.js`. Validation checks
  the result against the API's figure on closed rows inside one VAT period, so
  a VAT change missing from the schedule fails loudly.
- **The price cap** comes from `cap.json`, kept by hand because Ofgem
  publishes no machine-readable feed. Each quarter, when Ofgem announces the
  next cap, add one row per region (`from`, `to`, `region`, `electricity` and
  `gas` `unit`/`standing` exc VAT, `typicalBill`, `source`). Until a period is
  entered the cap line stops at the last one and validation warns.
- **Comparisons start 2023-07-01.** The Energy Price Guarantee is not modelled,
  so earlier dates are not offered.
- **Rate limit.** The API sits behind CloudFront, which answers HTTP 429 after
  roughly 1,500 requests in three minutes at 8 in flight. `src/net.js` spaces
  request starts 250 ms apart (about 4 a second) and waits out a 429 with
  1, 2, 5, 5 and 10 minute backoffs. A full backfill takes over an hour; a
  daily refresh a few minutes.

## Adding a tariff family

1. Add an entry to `families.json` (`id`, `label`, `kind`, `match`, `series`,
   `fuels`) and put its `match` pattern in `log.match`, verbatim.
2. Run `npm run collect`; it backfills the new family's whole history. Then
   `npm run build && npm run check`, and commit `families.json`, `data/` and
   `docs/` together.

A family whose rates have a new shape needs a series module under
`src/series/` too. Time-of-use families (Go, Cosy, Intelligent Go) also need a
compact store first: their windowed rows repeat daily, so a one-row-per-window
CSV runs to about 80-530 KB per endpoint.

## Routine

Every day at 06:00 UTC (`0 6 * * *`) a Claude Code routine runs
`node src/routine.js` in a fresh clone of `master`. Its saved prompt only
points to [`ROUTINE.md`](ROUTINE.md), so behaviour changes are commits. The
script collects, builds, runs `npm run check:core`, and if anything under
`data/` or `docs/` differs commits both and pushes `HEAD:master`. A
non-fast-forward push fails the run and the next run redoes it. Every
successful run, including an unchanged one, pings `$HEALTHCHECK_URL`; any error
pings `$HEALTHCHECK_URL/fail`.

`node src/routine.js --probe` pings `$HEALTHCHECK_URL/start` (it fails when the
URL is unset), makes one API request, commits a `.routine-probe` timestamp to
`master` and pings the healthcheck. It is run once before the
first real run to prove the push and both hosts.

## Developing

```sh
npm ci
git config core.hooksPath hooks   # runs `npm run check` before every push
```

Zero runtime dependencies, plain ESM, Node >= 22; Playwright and Biome are the
only devDependencies.

| script | runs |
|---|---|
| `npm test` | `node --test 'test/**/*.test.js'` |
| `npm run check:syntax` | `node --check` over `src/` and `scripts/` |
| `npm run check:data` | `node src/validate.js` |
| `npm run check:lint` | `biome check` |
| `npm run check:browser` | Playwright smoke test (local only) |
| `npm run check:core` | test + syntax + data: what the routine runs before a commit |
| `npm run check` | everything: what `hooks/pre-push` runs |

To preview, serve a directory whose `octopus-tariffs/` entry points at `docs/`
with any static server, and open `/octopus-tariffs/`; the site uses relative
URLs and expects that prefix.
