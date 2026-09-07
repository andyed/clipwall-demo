# Vendored from muriel

These files are **copies**, not the source. Edit them upstream and re-sync;
edits made here are lost on the next sync and, worse, silently diverge from a
library that other consumers are still tracking.

| | |
|---|---|
| upstream | `~/Documents/dev/muriel` — `render_assets/_lib/` |
| commit | `9c047f5a13a87aab47156d2c1997700e4ba7e4f1` |
| dated | 2026-09-07 |
| branch | feat/hybrid-tile-field |

The synced working tree additionally includes the uncommitted `piles.js` depth
and spread-width fixes and `hybrid.js` eligibility hook, verified by upstream
`tests/spatial-piles.test.mjs` and `tests/spatial-hybrid.test.mjs`.
The commit above is the base revision, not a claim that those fixes are committed.

Vendored rather than imported because clipwall has no build step and no
dependency on muriel's checkout being present. The cost is staleness, which is
why the commit is recorded above and `sync.mjs` checks it.

```bash
node wall/spatial/lib/sync.mjs          # report drift
node wall/spatial/lib/sync.mjs --pull   # re-copy and update this file
```
