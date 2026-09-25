# Imager — board (state of record)

A record is prose about state: verify it against `git log`, `git worktree list`,
the subagent registry and `pgrep -af "vites[t]"` before acting on it.

## Standing facts
- Remote: `origin` = `https://github.com/ArndRosemeier/Imager.git` (added
  2026-09-25 on the owner's instruction; HTTPS via the host-global credential
  store). Branch `main`. **A push here does NOT deploy** — no workflows exist in
  this repo; publishing is the separate `apps-publish` step, still unscoped.
- **PUBLISHED** `https://apps.futuremagic.de/imager/` (ledger row 8) — symlink
  `~/apps/imager` → `~/projects/Imager/dist`, so a rebuild is live immediately. Slice 3 republished 2026-09-25: public JS sha `4d40f82a…` == local dist, local+public 200.
  Verified: local 200 + public 200, public JS sha == local dist sha. Republish
  after a change = rebuild + confirm the new asset hash is served.
- Session goal: created and paused per the chief-of-staff contract; never touched again.

## Landed (verified by CoS)
| Slice | sha | CoS verification |
|---|---|---|
| 0 bootstrap (ledger row 1) | `debd338` | Full gate exit 0 (2 files / 2 tests), log `.gate-logs/cos-verify-debd338.log`. Injection: heading renamed → smoke pin RED (exit 1, "Unable to find … heading … Imager"), restored by trap, tree clean. Lock probe: held lock → gate exit 9 VOID. |
| 1 settings + model knowledge (ledger row 2) | `d68daf8` | Full gate exit 0 (6 files / 14 tests), log `.gate-logs/cos-verify-d68daf8.log`. Own injection (distinct from writer's): `canGenerateImages` reads input instead of output modalities, sha 55c4cf88→93adeea5 → pin `classifies the real fixture entries` RED (exit 1), restored sha 55c4cf88, tree clean. |

| 2 generate + gallery (ledger row 5) | `673e805` | Full gate exit 0 (9 files / 23 tests), log `.gate-logs/cos-verify-673e805.log`. Own injection (distinct from writer's envelope arm): count cap `maxCount = 10`, sha 90a88da4→299436f7 → pin `count never exceeds the model's published n max` RED (1 failed / 23), restored sha 90a88da4. Gate self-match bug fixed alongside (ledger row 6). |
| 3 refine + whole width + dark mode (ledger row 9) | `ae50274` / `21a08e9` | Full gate exit 0 (12 files / 38 tests), log `.gate-logs/cos-verify-ae50274.log`. Own injection (in the owners' two UI asks, not the writer's arms): pre-paint theme default `'dark'`→`'light'`, sha 04bb47be→c836ea74 → theme-startup pin RED, restored 04bb47be. Republished: public JS sha `4d40f82a…` == local dist. |
| 4 refinement chat (ledger row 12) | `c819d37` / `52da43e` | Full gate exit 0 (15 files / 61 tests), log `.gate-logs/cos-verify-c819d37.log`. Own injection (the no-fallback rule, distinct from the writer's memory arm): image-model fallback injected into `chatBlockReason`, sha 53dd4a12→92629bda → pin `an empty refinement pick disables Send … falls back to NOTHING` RED, restored 53dd4a12. **Slice 4 is LIVE** (its build wrote through the `~/apps/imager` symlink; served JS sha `10b85f36…` == local dist).
## In flight
None.

## Queue (plan: owner-approved 2026-09-25)
2. Slice 5 — library/run log/cost/export.
3. Slice 6 — hardening (error/empty-state pass) + README.

## Open owner fork
None. (Auto-routers stay — ledger row 7.)

## Known debt / notes
- DISPATCHER ERROR (2026-09-25, slice-11 change): an injection's `trap` restored `src/features/generate/useImagePanel.ts` **from HEAD** while that slice was UNCOMMITTED, destroying the change; it was reapplied by hand and re-gated (40/40). The injected pin DID fire correctly (hash 768594f4→54904ace, RED). Lesson: while a slice is uncommitted, restore from an out-of-tree copy (`.gate-logs/inject-backup/`), never from HEAD.
- **A build publishes** (ledger row 13): `~/apps/imager` symlinks `dist`, so ANY `pnpm build` writes the public site. Verify the served JS hash after a build.
- Whole-app UNVERIFIED against the live service (no key yet): `/images` + `input_references`, chat `modalities`/assistant `images`, `/key`.
- Slice 2 UNVERIFIED without a key: the live `POST /images` response shape (fixture-based only); a response missing `media_type` now throws rather than guessing.
- Owner said publish AFTER slice 2 — ask before publishing.
- DISPATCHER ERROR (2026-09-25): `5ef4865` was committed on a RED gate (exit 1, stale count in `tests/features/settings-panel.test.tsx`). The chained command appended the ledger row and committed without testing the gate's exit code. Fixed forward in the next commit (full gate exit 0, 14/14). Rule for this session: commit ONLY after reading `GATE GREEN — exit 0`, never in the same command as the gate. Also ran that ~4s re-gate in the foreground.
- No fallback model (owner, ledger row 3).
- `/models` needs `?output_modalities=all`; the plain endpoint hides 46 image models (measured, ledger row 2).
- Per-model Images-API limits live at `/images/models` (n max, reference-image max) — slice 2/3 must read them, not guess.
- `scripts/gate.sh` is a simplified port: no chunking, no RSS watchdog, no
  build-config build step (docs/18 §4). Lock + exit 9 verified by CoS; the
  stale-lock path is not yet exercised.
- Dispatcher's own error (slice 0 brief): specified `tests/app/smoke.test.ts`
  for a JSX test — must be `.tsx`; writer corrected it.
