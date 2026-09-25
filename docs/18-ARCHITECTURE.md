# 18 — Architecture (seam index)

## §1 Layer map (today)

Slice 0 is an empty stage. The tree holds a placeholder only:

- `src/App.tsx` — renders the "Imager" heading + purpose line (pinned by
  `tests/app/smoke.test.ts`: removing the heading goes red).
- `src/main.tsx` — mounts `App` on `#root`, throws loudly if `#root` is
  missing (no silent fallback, rule 1).
- `src/index.css` — Tailwind v4 entry (`@import 'tailwindcss'`).
- `vite.config.ts` — `base: '/imager/'` (future publish subpath; dev
  unaffected), `@/*` alias, `test.maxWorkers` default 2 (the bound).
- `scripts/gate.sh` — the ONE suite runner (pinned by
  `tests/architecture/one-gate.test.ts`: a second `scripts/*.sh` goes red).

There are NO seams yet: no settings, no domain, no Dexie tables, no OpenRouter
calls, no image code. The rows below are STUBS — seams slice 1+ will create,
each naming its Campaigner donor file (absolute path, read-only reference —
never edit Campaigner).

## §2 Seams (stub — slice 1+ creates these)

| Seam | Will live | Donor in Campaigner |
|---|---|---|
| OpenRouter client (fetch, headers, timeout) | `src/llm/openrouter.ts` | `/home/administrator/projects/Campaigner/src/llm/openrouter.ts` |
| OpenRouter error mapping (loud, user-visible) | `src/llm/openrouterErrors.ts` | `/home/administrator/projects/Campaigner/src/llm/openrouterErrors.ts` |
| Image generation call (POST /images, webp, n-cap-to-1, 5-min timeout, fallback chain) | `src/llm/imageGen.ts` | `/home/administrator/projects/Campaigner/src/llm/imageGen.ts` |
| Model fallback chain (user pick stays the authority — no pinned default) | `src/llm/modelFallback.ts` | `/home/administrator/projects/Campaigner/src/llm/modelFallback.ts` |
| Model list cache | `src/llm/modelCache.ts` | `/home/administrator/projects/Campaigner/src/llm/modelCache.ts` |
| Image domain type + zod schema | `src/domain/image.ts` | `/home/administrator/projects/Campaigner/src/domain/image.ts` |
| Image Dexie repo | `src/db/imageRepo.ts` | `/home/administrator/projects/Campaigner/src/db/imageRepo.ts` |
| Image UI (generate / refine surfaces, in-app tabs — no router: static host has no history fallback) | `src/features/images/` | `/home/administrator/projects/Campaigner/src/features/images/` |
| Chat-refinement path (multi-turn, models that support image output) | TBD in slice 1+ | donor TBD — Campaigner's chat/LLM surfaces under `/home/administrator/projects/Campaigner/src/llm/` and `/home/administrator/projects/Campaigner/src/features/` |

## §3 Gotchas

- Static host has NO history fallback → v1 uses in-app tabs, never a router
  library. (Owner intent via brief; donor Campaigner uses react-router, which
  does NOT port.)
- Asset base MUST stay `/imager/` — `dist/index.html` must reference
  `/imager/`-based assets, verified by build proof each slice that touches
  config.
- Model choice is ALWAYS the user's explicit pick. Porting the donor's
  fallback chain must not smuggle in a pinned default.

## §4 Known debt

- `scripts/gate.sh` has no chunking, no RSS watchdog, no build-config-diff
  build step (Campaigner §Host hygiene 7 machinery). Deliberate: the suite is
  two files. Add them when the suite gets slow, not before.
- No `docs/20-ORCHESTRATION.md` board / `scripts/board.sh` reconciler yet —
  single writer, no remote. Establish before the first parallel-writer slice.
