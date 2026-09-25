# 18 — Architecture (seam index)

## §1 Layer map (today)

- `src/App.tsx` — full-width page shell (no `max-w-3xl` cap; prose blocks are
  bounded locally), heading + theme toggle in the header, in-app tab bar
  (Generate | Settings, `useState`, no router) + `<Toaster theme>`.
- `src/features/generate/GenerateArea.tsx` — the Create | Refine tablist + the
  ONE gallery both modes write to; owns the selected refinement source.
- `src/main.tsx` — mounts `App` inside `ErrorBoundary`; re-applies the theme
  through the seam; window `error` / `unhandledrejection` → `toastError`.
  Throws if `#root` is missing.
- `index.html` — the inline pre-paint theme script (the ONLY inline script).
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
| Images-API model limits (one session-cached PUBLIC `GET /images/models`; `limitsFor` → `{listed, maxCount, aspectRatios, maxReferences}`; unlisted → loud notice, count 1, no references) — the UI bounds count/aspect/REFINE by THIS, never guesses | `src/llm/imageModels.ts` | `tests/llm/images.test.ts` (real fixture `tests/fixtures/images-models-trimmed.json`), `tests/features/generate-panel.test.tsx`, `tests/features/refine-panel.test.tsx` | — |
| Image generation (`POST /images`, 5-min headers timeout, 200 error-envelope → typed error, zod, b64 → bytes, `filteredCount`, `usage.cost`; all filtered = throw). Slice 3 ADDS `input_references` here (as `GenerateRequest.inputReferences`), so ONE seam serves generate AND refine — no second image client. No fallback, no n-cap retry, and the donor's silent "retry without the references" 400 path is deliberately NOT ported (a model that rejects references must fail loudly, not quietly produce a text-to-image result) | `src/llm/images.ts` | `tests/llm/images.test.ts`, `tests/architecture/one-fetch.test.ts` (`image_url: { url:` in exactly one file) | Campaigner `src/llm/imageGen.ts` |
| Reference prep: stored image OR uploaded file → ONE `data:` URL for `input_references`, long edge capped at `REFERENCE_MAX_EDGE_PX` = 1024 (aspect preserved, never upscaled), decode failure THROWS | `src/features/refine/reference.ts` | `tests/features/refine-panel.test.tsx` | — |
| Image storage: domain `StoredImage`/`Run` (Uint8Array bytes; `source: 'generated' \| 'uploaded'`; `Run.kind: 'generate' \| 'refine'` + `inputImageIds`) + repo (`saveRun` atomic run+images, `saveUploadedImage`, zod on every read, corrupt row throws; a v2 row without the slice-3 fields reads as its old meaning, never as a corrupt row) | `src/domain/image.ts`, `src/db/imageRepo.ts`, `src/db/db.ts` (v3: content change, no index moves) | `tests/db/migration.test.ts` (v1 settings + v2 rows survive), `generate-panel.test.tsx`, `refine-panel.test.tsx` | Campaigner `src/domain/image.ts`, `src/db/imageRepo.ts` |
| Generation/refinement run (one call → exactly one run row; failure = failed row + rethrow → toast) + Generate UI (disabled-with-reason, Cancel via AbortSignal) + Refine UI (mode switch, source pick/upload, free-text instruction, disabled-with-reason) + the ONE result line `RunStatus` | `src/features/generate/`, `src/features/refine/RefinePanel.tsx` | `tests/features/generate-panel.test.tsx`, `tests/features/refine-panel.test.tsx` | — |
| Gallery (newest-first multi-column grid, lightbox: prompt/model/cost/date/size, Download with MIME extension, Delete, "Refine this" → the refine panel) + `useImageUrl` (object URL revoked on unmount) | `src/features/gallery/` | `tests/features/generate-panel.test.tsx`, `tests/features/refine-panel.test.tsx` | Campaigner `src/features/images/use-image-url.ts` |
| Theme (read/apply/persist/watch): `getTheme`/`setTheme`/`toggleTheme`/`useTheme`, the `dark` class on `<html>`, localStorage `imager.theme` as the ONE source of truth, default DARK when nothing is stored. The flash-free half is the inline script in `index.html` (the ONLY inline script), pinned to agree with the seam | `src/lib/theme.ts`, `src/components/ThemeToggle.tsx`, `src/index.css` (`@custom-variant dark`, semantic surface utilities), `index.html` | `tests/features/theme.test.tsx`, `tests/architecture/theme-startup.test.tsx` | — |
| Base64/data-URL bytes both ways (`b64_json` → bytes; bytes → base64 for a reference `data:` URL) | `src/lib/base64.ts` | `tests/llm/images.test.ts`, `tests/features/refine-panel.test.tsx` | Campaigner `src/lib/base64.ts` |

Stubs, not built yet: the chat-refinement path (chat completions with `modalities`, slice 4),
fallback chain (owner has NOT asked — queue question).

## §3 Gotchas

- The static host has NO history fallback → Imager uses in-app tabs (the
  Generate | Settings bar, and Create | Refine inside it), never a router
  library. (Owner intent via brief; donor Campaigner uses react-router, which
  does NOT port.) `index.html` must stay small: exactly one inline script (the
  pre-paint theme read) and nothing else.
- Asset base MUST stay `/imager/` — `dist/index.html` must reference
  `/imager/`-based assets, verified by build proof each slice that touches
  config.
- Bare `GET /models` lists TEXT-output models only; image-only models
  (flux, gpt-image, …) need `?output_modalities=all` (measured, docs/17 row 2).
- Model choice is ALWAYS the user's explicit pick. Porting the donor's
  fallback chain must not smuggle in a pinned default.
- A refinement instruction is FREE TEXT sent to the model verbatim — never
  regex-parsed, never used to infer parameters (rule 5).

## §4 Known debt

- `scripts/gate.sh` has no chunking, no RSS watchdog, no build-config-diff
  build step (Campaigner §Host hygiene 7 machinery). Deliberate: the suite is
  two files. Add them when the suite gets slow, not before.
- No `docs/20-ORCHESTRATION.md` board / `scripts/board.sh` reconciler yet —
  single writer, no remote. Establish before the first parallel-writer slice.
