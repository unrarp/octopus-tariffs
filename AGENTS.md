# octopus-tariffs

- **Every tracked file is public** — the repo is public and `docs/` is served at
  `unrarp.github.io/octopus-tariffs/`. No tokens, no `.env`, nothing private.
- **Zero runtime dependencies, plain ESM JavaScript, Node ≥ 22, `node --test`.**
  Playwright and Biome are the only devDependencies. No TypeScript, bundler or
  GitHub Actions.
- **`data/` and `docs/` (except `docs/vendor/`) are machine-written** by
  `src/collect.js`, `src/build.js` and the routine. Never hand-edit them.
- **`npm run check` must pass before every push from a dev machine**
  (`hooks/pre-push` enforces it). The routine has no browser, so it
  runs `npm run check:core` before every commit instead.
- **Never `git add -A` or `git add .`** — add paths explicitly.
- **Tests must be seen failing** before they count: bug fixes fail before the
  fix; other new tests are broken deliberately, watched failing, then restored.
- **The routine commits to `master` daily** whenever `data/` or `docs/` changed.
  It starts from a fresh clone, so change its behaviour through tracked files
  (`ROUTINE.md`, `src/routine.js`), never the saved prompt on claude.ai.
- **Families are config** — add or change a tariff family in `families.json`
  (plus a series module if its shape is new), never in code.
- **No root-absolute URLs in `docs/`** — the site lives at `/octopus-tariffs/`.
