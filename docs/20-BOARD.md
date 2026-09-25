# Imager — board (state of record)

A record is prose about state: verify it against `git log`, `git worktree list`,
the subagent registry and `pgrep -af "vites[t]"` before acting on it.

## Standing facts
- Local repo only, branch `main`, **no remote** (owner provides the GitHub repo
  later; do not create one, do not push).
- Not published. Target when scoped: `https://apps.futuremagic.de/imager/` via
  skill `apps-publish` (`base: '/imager/'` already set).
- Session goal: created and paused per the chief-of-staff contract; never touched again.

## Landed (verified by CoS)
| Slice | sha | CoS verification |
|---|---|---|
| 0 bootstrap (ledger row 1) | `debd338` | Full gate exit 0 (2 files / 2 tests), log `.gate-logs/cos-verify-debd338.log`. Injection: heading renamed → smoke pin RED (exit 1, "Unable to find … heading … Imager"), restored by trap, tree clean. Lock probe: held lock → gate exit 9 VOID. |

## In flight
Slice 1 (ledger row 2) — writer `3e9c1fa9`, main tree, sole writer, based on `754d061`.

## Queue (plan: owner-approved 2026-09-25)
1. **Slice 1 — settings + key + model pickers + capability spike.** Settings row
   (key, image model, refine-chat model — ALL empty by default, explicit "pick a
   model" state), key test, live model lists. Spike answers, into the ledger:
   which models accept `input_references`, which do chat-with-image-output, `n`
   caps, size/aspect params.
2. Slice 2 — text-to-image + gallery (port `imageGen.ts`).
3. Slice 3 — Images-API refinement (`input_references`, upload-as-seed, variants).
4. Slice 4 — **chat refinement** (multi-turn chat, image output, only for capable models).
5. Slice 5 — library/run log/cost/export.
6. Slice 6 — hardening + publish via `apps-publish`.

## Known debt / notes
- `scripts/gate.sh` is a simplified port: no chunking, no RSS watchdog, no
  build-config build step (docs/18 §4). Lock + exit 9 verified by CoS; the
  stale-lock path is not yet exercised.
- Dispatcher's own error (slice 0 brief): specified `tests/app/smoke.test.ts`
  for a JSX test — must be `.tsx`; writer corrected it.
