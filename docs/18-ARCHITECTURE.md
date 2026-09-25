# 18 — Architecture (seam index)

## §1 Layer map (today)

- `src/App.tsx` — heading + in-app tab bar (Generate | Settings, `useState`, no router) + `<Toaster>`.
- `src/main.tsx` — mounts `App` inside `ErrorBoundary`; window `error` /
  `unhandledrejection` → `toastError`. Throws if `#root` is missing.
- `vite.config.ts` — `base: '/imager/'`, `@/*` alias, `test.maxWorkers` 2.
- `scripts/gate.sh` — the ONE suite runner (pin `tests/architecture/one-gate.test.ts`).

## §2 Seams

| Seam | Lives | Pin | Donor (read-only) |
|---|---|---|---|
| OpenRouter transport (base URL, headers, retries 429/5xx, headers timeout, zod `readJson`) — the ONLY `fetch(` in `src/` | `src/llm/client.ts` | `tests/architecture/one-fetch.test.ts` | Campaigner `src/llm/openrouter.ts` |
| OpenRouter typed errors + envelope parse | `src/llm/errors.ts` | `tests/llm/models.test.ts` | Campaigner `src/llm/openrouterErrors.ts` |
| Model list (one session-cached `GET /models?output_modalities=all`) + capabilities `canGenerateImages` / `acceptsImageInput` / `canRefineViaChat` / `producesTextToo` — later slices ASK these, never guess from ids | `src/llm/models.ts` | `tests/llm/models.test.ts` (real fixture `tests/fixtures/models-trimmed.json`) | Campaigner `src/llm/modelCache.ts`, `listImageModels` |
| Key test (`GET /key`) | `src/llm/key.ts` | `tests/features/settings-panel.test.tsx` | — |
| Settings (domain schema, empty defaults, no model literal in `src/`) | `src/domain/settings.ts` | `tests/db/settings.test.ts`, `one-fetch.test.ts` | Campaigner `src/domain/settings.ts` |
| Dexie DB (one class, versions here) + settings repo (corrupt row throws) | `src/db/db.ts`, `src/db/settingsRepo.ts` | `tests/db/settings.test.ts` | Campaigner `src/db/` |
| Toast (the one notice surface) + error helpers `errorMessage` / `toError` | `src/lib/toast.ts`, `src/lib/errors.ts` | — | Campaigner `src/lib/toast.ts` |
| Global error boundary | `src/components/ErrorBoundary.tsx` | — | — |
| Settings UI (key, test, two searchable pickers) | `src/features/settings/` | `tests/features/settings-panel.test.tsx` | — |
| Images-API model limits (one session-cached PUBLIC `GET /images/models`; `limitsFor` → `{listed, maxCount, aspectRatios}`; unlisted → loud notice, count 1) — the UI bounds count/aspect by THIS, never guesses | `src/llm/imageModels.ts` | `tests/llm/images.test.ts` (real fixture `tests/fixtures/images-models-trimmed.json`), `tests/features/generate-panel.test.tsx` | — |
| Image generation (`POST /images`, 5-min headers timeout, 200 error-envelope → typed error, zod, b64 → bytes, `filteredCount`, `usage.cost`; all filtered = throw). No fallback, no `input_references`, no n-cap retry | `src/llm/images.ts` | `tests/llm/images.test.ts` | Campaigner `src/llm/imageGen.ts` |
| Image storage: domain `StoredImage`/`Run` (Uint8Array bytes) + repo (`saveRun` atomic run+images, zod on every read, corrupt row throws); Dexie v2 adds `images`, `runs` | `src/domain/image.ts`, `src/db/imageRepo.ts`, `src/db/db.ts` | `tests/db/migration.test.ts` (v1 settings row survives), `generate-panel.test.tsx` | Campaigner `src/domain/image.ts`, `src/db/imageRepo.ts` |
| Generation run (one call → exactly one run row; failure = failed row + rethrow → toast) + Generate UI (disabled-with-reason, Cancel via AbortSignal, filter/cost line) | `src/features/generate/` | `tests/features/generate-panel.test.tsx` | — |
| Gallery (newest-first grid, lightbox: prompt/model/cost/date/size, Download with MIME extension, Delete) + `useImageUrl` (object URL revoked on unmount) | `src/features/gallery/` | `tests/features/generate-panel.test.tsx` | Campaigner `src/features/images/use-image-url.ts` |
| Base64 → bytes | `src/lib/base64.ts` | `tests/llm/images.test.ts` | Campaigner `src/lib/base64.ts` |

Stubs, not built yet: refinement via `input_references` (slice 3), chat-refinement path (chat completions with
`modalities`), fallback chain (owner has NOT asked — queue question).

## §3 Gotchas

- Static host has NO history fallback → v1 uses in-app tabs, never a router
  library. (Owner intent via brief; donor Campaigner uses react-router, which
  does NOT port.)
- Asset base MUST stay `/imager/` — `dist/index.html` must reference
  `/imager/`-based assets, verified by build proof each slice that touches
  config.
- Bare `GET /models` lists TEXT-output models only; image-only models
  (flux, gpt-image, …) need `?output_modalities=all` (measured, docs/17 row 2).
- Model choice is ALWAYS the user's explicit pick. Porting the donor's
  fallback chain must not smuggle in a pinned default.

## §4 Known debt

- `scripts/gate.sh` has no chunking, no RSS watchdog, no build-config-diff
  build step (Campaigner §Host hygiene 7 machinery). Deliberate: the suite is
  two files. Add them when the suite gets slow, not before.
- No `docs/20-ORCHESTRATION.md` board / `scripts/board.sh` reconciler yet —
  single writer, no remote. Establish before the first parallel-writer slice.
