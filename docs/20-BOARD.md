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
| 1 settings + model knowledge (ledger row 2) | `d68daf8` | Full gate exit 0 (6 files / 14 tests), log `.gate-logs/cos-verify-d68daf8.log`. Own injection (distinct from writer's): `canGenerateImages` reads input instead of output modalities, sha 55c4cf88→93adeea5 → pin `classifies the real fixture entries` RED (exit 1), restored sha 55c4cf88, tree clean. |

## In flight
None.

## Queue (plan: owner-approved 2026-09-25)
2. Slice 2 — text-to-image + gallery (port `imageGen.ts`).
3. Slice 3 — Images-API refinement (`input_references`, upload-as-seed, variants).
4. Slice 4 — **chat refinement** (multi-turn chat, image output, only for capable models).
5. Slice 5 — library/run log/cost/export.
6. Slice 6 — hardening + publish via `apps-publish`.

## Open owner fork
- Exclude `openrouter/auto` + `openrouter/auto-beta` (they choose the model themselves) from one or both pickers? Awaiting owner.

## Known debt / notes
- DISPATCHER ERROR (2026-09-25): `5ef4865` was committed on a RED gate (exit 1, stale count in `tests/features/settings-panel.test.tsx`). The chained command appended the ledger row and committed without testing the gate's exit code. Fixed forward in the next commit (full gate exit 0, 14/14). Rule for this session: commit ONLY after reading `GATE GREEN — exit 0`, never in the same command as the gate. Also ran that ~4s re-gate in the foreground.
- No fallback model (owner, ledger row 3).
- `/models` needs `?output_modalities=all`; the plain endpoint hides 46 image models (measured, ledger row 2).
- Per-model Images-API limits live at `/images/models` (n max, reference-image max) — slice 2/3 must read them, not guess.
- `scripts/gate.sh` is a simplified port: no chunking, no RSS watchdog, no
  build-config build step (docs/18 §4). Lock + exit 9 verified by CoS; the
  stale-lock path is not yet exercised.
- Dispatcher's own error (slice 0 brief): specified `tests/app/smoke.test.ts`
  for a JSX test — must be `.tsx`; writer corrected it.
