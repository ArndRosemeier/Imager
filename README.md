# Imager

A standalone local-first web app to generate images with OpenRouter and refine
them — both via the Images API (`input_references`) and, for models that
support it, via a multi-turn chat-completion path with image output.

Model choice is always the user's explicit pick — there is no pinned default.

## Local dev

Requires `pnpm@11.26.0` (lives at `~/.local/bin/pnpm`); the shared pnpm store
at `~/.local/share/pnpm/store` is reused — no project-local store.

```bash
pnpm install
pnpm dev        # Vite dev server (unaffected by the /imager/ base)
pnpm typecheck  # tsc -b
pnpm lint       # eslint .
pnpm test       # vitest run (2 workers by default, see vite.config.ts)
pnpm build      # tsc -b && vite build
```

## Gate

`scripts/gate.sh` is the ONE way to run the suite (see `AGENTS.md` §The gate
and the clock). Full run: `bash scripts/gate.sh` (exit 0 GREEN / 1 RED).
Compile tier: `GATE_TESTS=0 bash scripts/gate.sh` (exit 2 — the suite did NOT
run). Exit 9 = the suite lock is held, VOID — wait and retry.

## Publishing

Static publishing to `https://apps.futuremagic.de/imager/` happens in a LATER
slice via the `apps-publish` skill — there are no publish instructions yet
beyond this pointer. The Vite `base` is already `/imager/` (the future
subpath; the dev server is unaffected), and v1 uses in-app tabs, not a router
(the static host has no history fallback).

## Status

Slice 0: wired, gated, documented empty stage — a placeholder `App` ("Imager"
heading), one smoke test, one gate pin, and the process docs. No OpenRouter
calls, no Dexie tables, no settings UI yet — that is slice 1+.
