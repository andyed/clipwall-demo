# Vendored from muriel

These files are **copies**, not the source. Edit them upstream and re-sync;
edits made here are lost on the next sync and, worse, silently diverge from a
library that other consumers are still tracking.

| | |
|---|---|
| upstream | `~/Documents/dev/muriel` — `render_assets/_lib/` |
| commit | `3f288f660e4cdbae891d57123e3cffcfa4d7de85` |
| dated | 2026-09-10 |
| branch | feat/html-in-canvas-probe (pushed) |

Every vendored byte matches that commit exactly — checked file by file against
`git show HEAD:render_assets/_lib/…`, not against the upstream working tree.
That distinction is the one `sync.mjs` cannot make: it compares working trees,
so an upstream whose changes are real but uncommitted reports as a clean match
while the copy is the more durable of the two. It said "matches upstream" for
three days in exactly that state.

Vendored rather than imported because clipwall has no build step and no
dependency on muriel's checkout being present. The cost is staleness, which is
why the commit is recorded above and `sync.mjs` checks it.

```bash
node wall/spatial/lib/sync.mjs          # report drift
node wall/spatial/lib/sync.mjs --pull   # re-copy and update this file
```

2026-09-07: pulled upstream contact-sheet pile face (`PileLayout.faceOf`, `faceCount`); the app promotes face members and skips them in its contain pass.
2026-09-07: pulled square-grid face and empty-pile guard (upstream 5778a5c); the app places each clip in its smallest group, keeps true counts, and a spread pile borrows shared members.
2026-09-10: upstream committed and pushed (muriel 9c70231, 3f288f6); the drawable card source (`cards.js`, `AtlasPair.resolveSource`, `RETRY`, `slotCoverage`) is now vendored from a real revision rather than from someone's working tree.
