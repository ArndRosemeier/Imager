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
| fix encode bug (ledger rows 14-15) | `ef1a5b0` | Full gate exit 0 (16 files / 67 tests), log `.gate-logs/cos-verify-ef1a5b0.log`. Own real-Chrome reproduction: OffscreenCanvas `toDataURL` = undefined, old call threw the owner's exact TypeError, `convertToBlob` produced a real 1024×512 PNG from 2000×1000. LIVE: public JS sha `1a19eec0…` == local dist. |
| base image in chat (ledger row 16) | `baa4a9e` | Full gate exit 0 (16 files / 72 tests, `.gate-logs/chat-base-image2.log`); a first run was RED on **eslint only** (an `any` from `expect.stringContaining` in a new test) and was fixed forward before any push. Own injection: the original `content: text` branch restored, sha 15bee9d5→a036c9bc → 3 pins RED, restored 15bee9d5. LIVE: public JS sha `a7c49957…` == local dist (a first public read showed a transient stale-edge hash; re-read matched). |
| gallery → chat + full-view layout (ledger row 17) | `bb367d9` / `d79934f` | Full gate exit 0 (18 files / 79 tests, `.gate-logs/cos-verify-bb367d9.log`). Layout verified from code + writer's browser evidence: image 734×734 in a 1400×900 viewport (old `70vh` cap = 630); the cap string is gone from `src/` and the built CSS. LIVE: public JS sha `58bdc257…` == local dist. |
| beauty pass (ledger row 20) | `3bb7012` / `3f2cbe3` | Full gate exit 0 (19 files / **88** tests, `.gate-logs/cos-verify-beauty.log`), typecheck + eslint + vitest. CoS viewed the writer's real-browser screenshots in BOTH themes (`.gate-logs/beauty/after-*.png`): art-forward grid, one compact bar, controls rail, decluttered captions, chat reads as a conversation. Contrast re-measured by the writer from the built CSS (accent 6.31/6.29, body 15.21/16.96, muted 6.40-7.56) and now floored by `tests/architecture/design-system.test.ts`. LIVE and intended (a build publishes).
| prompt copy button (ledger row 22) | `cc85e56` / `d30bdb3` | Full gate exit 0 (21 files / **96** tests, `.gate-logs/cos-verify-cc85e56.log`). CoS verified the load-bearing CSS in the BUILT stylesheet: `.tile-copy{opacity:0}` (19946) vs `group-focus-within:opacity-100` (21849) in the SAME layer, so keyboard focus reveals the control — a control hidden by opacity stays tabbable, so this mattered. Writer's real-browser clipboard read-back: exact untruncated prompt. Own probe `.gate-logs/cos-focus/check.mjs`. LIVE (build publishes). |
| save all + per-image save (ledger row 25) | `992868d` / `f0dc996` | Full gate exit 0 (26 files / **133** tests, `.gate-logs/cos-verify-992868d.log`). CoS built the backup archive itself with a SENTINEL key and scanned raw bytes + every entry: key absent; manifest settings = exactly [imageModel, refineChatModel]. Mode A = images only, stored bytes intact. Writer's real-browser evidence: 3+4 entry archives, per-image sha256 matching Node, native `showSaveFilePicker` present. LIVE (build publishes). |
| load backup / import (ledger row 27) | `421f9e7` / `450bb96` | Full gate exit 0 (31 files / **177** tests, `.gate-logs/cos-verify-import2.log`, read from the top). CoS independent 4-part check (built from the app's own exporter): apply-settings keeps a sentinel live key byte-identical AND takes archived models; keep-settings keeps both; ONE tampered byte refused at read with zero writes; a manifest re-adding the key refused by the strict schema. Writer's real-browser round trip: export → wipe → import (3 added) → re-import Keep both (3 skipped) → Replace existing (3 replaced), key unchanged throughout. LIVE.
## In flight
None.

## Queue (plan: owner-approved 2026-09-25)
2. Slice 5 — library/run log/cost/export.
3. Hardening (error/empty-state pass) + README.
4. Optional future: image streaming/partial previews; prompt expansion; light-theme browser pass on the lightbox (row 17 note 3).

## Open owner fork
None. (Auto-routers stay — ledger row 7.)

## Known debt / notes
- The native file-picker DIALOG cannot be driven headlessly (recorded as unverified in row 25); the fallback anchor path and the archive bytes ARE verified.
- Import (mode-B LOAD) is REQUIRED by the owner and NOT built: own slice, writes from the row-25 format spec. Owner decisions to honour: conflict = ask at import time; settings restore = choose per import.
- `deleteImage` does not scrub conversations, so dangling image ids exist by design; an import must tolerate them.
- Prompt copy: the desktop HOVER reveal path is browser-unverified (headless reports `(hover: none)`); the always-visible touch fallback IS verified. Model-id copy deliberately not built (owner asked for the prompt).
- Killing by pattern matched the killer's own shell TWICE (ledger row 24). Use capture-to-file then `xargs -r kill < file`, in two calls.
- LEDGER NUMBERING (row 21, repaired): the dispatcher twice gave the same number to different rows (append-without-reading-next-free, then a collision). Fix + the rule are recorded in ledger row 21. **Read the next free row number BEFORE writing the brief.**
- **RETRACTED (row 29):** the board previously recorded `f0dc996` as passing the full gate. The committed file failed eslint (`await-thenable`); the gate claim was false. See ledger row 29.
- Import UNVERIFIED: the native `showOpenFilePicker` DIALOG (headless cannot drive it; stubbed at the real name/signature), the `<input type=file>` fallback in a real browser, and a dangling-ref archive in-browser (unit-pinned only).
- Beauty pass UNVERIFIED on: resizing across the 1024px rail/sheet boundary, and the narrow-screen conversations list still paints above the thread.
- Design tokens: `.gate-logs/beauty/` holds the before/after screenshots, `capture.mjs` (dispatcher's loop) and `writer-check.mjs` (writer's). Both are gitignored evidence.
- A CDN read can be STALE mid-deploy: one public fetch returned a hash that did not match `dist` while the size did; the next fetch matched. Re-read before diagnosing a deploy problem (do not loop).
- Slice 3 style: `expect.stringContaining` in a test trips `@typescript-eslint/no-unsafe-assignment` (an `any`); assert explicitly.
- A browser-only API behind a jsdom stand-in can ship broken (ledger rows 14/15): doubles must mirror the real method name/signature/async-ness, and such an API needs a REAL-BROWSER pin. Dispatcher error logged: a `pkill`-style pattern matched its own shell and killed the command (the same self-match class as the gate probe, ledger row 6) — kill by PID from a PID list captured in an earlier call.
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
