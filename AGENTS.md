# Imager — agent/workspace rules

Standalone local-first web app: generate images with OpenRouter and refine
them — via the Images API (`input_references`) and, for models that support
it, via a multi-turn chat-completion path with image output. Vite + React +
TS strict, Tailwind, Dexie, zod, OpenRouter — no backend. Model choice is
ALWAYS the user's explicit pick (no pinned default). It IS published, at
`https://apps.futuremagic.de/imager/`, via a symlink from `~/apps/imager` to
`dist/` (skill `apps-publish`: static only, no history fallback → in-app tabs,
asset base `/imager/`) — so `pnpm build` publishes immediately (see Workflow).

Spec lives in `docs/` — read the relevant doc before working on an area.

## Binding engineering rules

1. **No silent fallbacks.** When data, parsing, or a step fails, propagate a
   loud error — never substitute placeholder output. Concretely forbidden:
   `catch`-and-continue around parsing/validation, `console.error` without a
   user-visible surface, placeholder values standing in for required data.
   Defaults are allowed ONLY for genuine user preferences and optional
   enrichment, never to mask a failure.
2. **Errors must be visible.** Every caught error surfaces via the app's one
   toast/error surface, the global error boundary, or a failed row with a
   message. No error may end in `console.error` only.
3. **Validate at every boundary.** LLM/JSON output is parsed with zod; a
   validation failure is an error (fail the run / pause for review), never a
   path to empty data.
4. **Centralize what is duplicated, and keep it simple** (owner-directed,
   verbatim: *"Always try to centralize when you see distributed code pieces
   that do basically the same. KISS principle, keep it simple."*). When one
   idea is implemented in more than one place, make it ONE seam and have the
   callers go through it. When you touch a pattern that is ALREADY
   distributed, folding it into one seam is part of the change unless that is
   genuinely more expensive than the defect — in which case say so plainly and
   leave a note where the next reader will hit it. Prefer the smallest design
   that does the job — no speculative generality, no abstraction serving a
   single caller.
5. **NEVER PARSE FREE TEXT WITH A REGEX — free text is read by the MODEL, and
   structured input needs a STRUCTURED FORM** (owner-directed, ported from
   Campaigner). A pattern over a STRUCTURED field the app itself defines or a
   data format it is contractually given is FINE; a pattern over HUMAN OR
   MODEL FREE TEXT — a refinement instruction, a chat message, generated prose
   — is a DEFECT. The free text is read by a structured, zod-validated MODEL
   call answering `null` honestly when the text asks for nothing, and what it
   read is NAMED on the user-visible surface so a wrong read is correctable in
   one step. If the value must be exact, the FORM becomes structured and the
   free text stops being the input. (Directly load-bearing for the
   chat-refinement path: a refinement chat message is free text, never a
   regex source.)

## Standing rule: critique the instruction (owner-directed)

The owner's instructions are INTENT, not design. Never implement a mechanism
you can show is flawed, and never flatten a request into literalism when a
better route to the same intent exists. Extract the intent first; say plainly
when the ask is flawed, with the better way and its reasoning, briefly; never
substitute silently (the owner must always see which decisions were theirs);
judge whether pushback is worth the friction; route the critique through
reality, not taste ("this breaks X, here is the code that proves it"). Every
brief states the intent and the chosen mechanism, and instructs the writer to
report BLOCKED (with the reasoning) rather than implement something it can
prove is wrong — including when the flaw is in the brief's own design. If the
owner reaffirms the original direction, execute it well and stop re-arguing.

## Centralization (rule 4, made mechanical)

1. **A brief names the seam it extends.** Before dispatching, find how the repo
   already does the thing (grep, then `docs/18` §2) and name that ONE seam in
   the brief. A writer that finds a SECOND mechanism for the same idea reports
   it in its landing report instead of quietly adding a third.
2. **A centralization lands with an "exactly one" pin** — a test that goes red
   when a second implementation appears. Never centralize by prose alone.
3. **An index entry is checkable, a decision is history.** `docs/18` rows name
   a seam and where it lives — a landing that moves or deletes one updates the
   row in the same commit. Docs that RESTATE behaviour rot, so the test is the
   statement instead; docs that record DECISIONS never rot, which is why
   `docs/17` works.
4. **A discovery that spans more than one code piece starts with the seam
   question, and the answer is WRITTEN DOWN.** Every brief and every landing
   report carries ONE greppable line —
   `COPIES: n→1 — <the seam that now carries it>` when copies are folded, or
   `COPIES: 1 — checked, no duplication (grepped: <what>)` when the change
   really is single-site. A brief without that line is incomplete; a landing
   without it is not verified.

## Workflow

- Start every task at `docs/18-ARCHITECTURE.md` (the seam index), then read
  the feature spec for the area you are touching.
- The PROCESS itself is described self-containedly in
  `docs/22-DEVELOPMENT-PROCESS.md`. Read it when you are new to this workflow.
- Any slice that adds or changes a seam amends `docs/18-ARCHITECTURE.md` in
  the same commit as the change — an unamended seam is treated as missing.
- Commit style: subject + body + test count. Author identity is set per-commit
  via `git -c user.name='Imager Dev' -c user.email='dev@imager.local' commit`.
- One logical task per commit. The remote IS `origin` =
  `https://github.com/ArndRosemeier/Imager.git`; a WRITER commits locally and
  does **not** push — the dispatcher pushes after verifying.
- **A BUILD PUBLISHES.** `~/apps/imager` is a symlink to this repo's `dist/`
  (skill `apps-publish`), so `pnpm build` (which the gate runs for a
  build-config diff, and which writers run to prove the bundle) writes the
  PUBLIC site at `https://apps.futuremagic.de/imager/` at once. There is no
  separate publish step to forget. Consequences: never build a tree you would
  not let the public see; after any build, expect the live site to have moved,
  and verify the served JS hash against `dist/` rather than assuming it did not.

## The gate and the clock

1. **The gate is `scripts/gate.sh` — the ONE way the suite runs.** Do not
   hand-roll a test command. A writer runs its gate IN-TURN, in the
   foreground: a subagent's background jobs DIE when its turn ends, so
   "background and wait for the notice" loses the run.
2. **Two tiers.** `GATE_TESTS=0 bash scripts/gate.sh` is the COMPILE tier
   (typecheck; `GATE_CHECKS=all` adds eslint), exiting 2 — a result that did
   NOT run the suite and must never be reported as "the gate passed". The
   default FULL run (typecheck + eslint + `vitest run`) exits 0 GREEN / 1 RED
   and is what makes a change VERIFIED. A docs-only diff (vs HEAD, `*.md`
   only) may take the compile tier. A slice that touches the VERIFICATION
   MACHINERY ITSELF (`scripts/gate.sh`, `vite.config.ts`, `tsconfig*.json`,
   `package.json`/the lockfile, test setup/helpers) runs the FULL gate
   in-turn — only running the suite THROUGH those changes can verify them.
3. **One suite at a time, enforced by an atomic lock** (`mkdir` at
   `<git-common-dir>/.imager-lock`), not by a glance. Exit 9 = the lock is
   held, VOID — wait and retry, never reap another actor's processes. A lock
   older than 30 minutes with no `vites[t]` alive is STALE (a killed run):
   remove it and say so.
4. **Quote exit codes exactly and never inflate them.** `0` = GREEN,
   `2` = compile tier only, `9` = refused/void, `1` = RED.
5. **NEVER pipe a gate through `tail`/`head`.** A pipeline's exit status is the
   LAST command's, so `gate | tail` returns success whatever the gate did —
   and the failing evidence (test name, expected/received) is destroyed. Keep
   the RAW log under `.gate-logs/` and quote from the file.
6. **Never poll.** No blocking waits, no sleep-and-check loops.

## Parallel writers

- **At most TWO writers in flight**, each in its OWN worktree under
  `/home/administrator/projects/Imager/worktrees/<slice>` (in-repo,
  gitignored and eslint-ignored). Writers sharing one tree share one git
  index, and `git commit` commits the whole index — file-disjointness does NOT
  protect the commit phase.
- **ABSOLUTE paths, stated twice in every brief and used in every call.**
  Every bash call runs in a fresh shell whose working directory is the session
  workspace, and file tools resolve RELATIVE paths against that same workspace
  — so every `read`/`edit`/`write`/`bash` call MUST use an absolute path under
  the worktree (or pass a workdir), or the edit lands in the MAIN tree.
- **File disjointness holds for `src/` and CANNOT hold for the docs.** Every
  landing amends the ledger (and usually the seam index). The dispatcher
  assigns the ledger row number in every brief; a writer that still hits a
  docs conflict resolves it as a mechanical UNION (renumber its OWN row only,
  touch nothing of the other landing, re-gate the FULL suite on the rebased
  tree). A conflict anywhere else: STOP and report.
- Sole-writer slices need no worktree but STILL use absolute paths under
  `/home/administrator/projects/Imager` in every call.

## Host hygiene

- **Gates are bounded BY DEFAULT — the config is the bound.**
  `vite.config.ts` defaults `maxWorkers` to 2, so the bare
  `pnpm exec vitest run` cannot exceed two workers. Raise it only via
  `IMAGER_TEST_WORKERS` for a run that owns the machine. One suite run at a
  time per writer; never leave a suite running when a turn ends.
- **No synthetic load, ever.** No busy-loop scripts, no stress harnesses. A
  flake is proved deterministic by DELAYING its cause and repeating the suite
  SEQUENTIALLY — never by loading the machine.
- **Nothing outlives the writer.** Scratch files live under the writer's own
  tree (or `.gate-logs`), never `/tmp`. Every process started is foreground
  or killed before reporting.
- **Reuse the SHARED pnpm store** (`~/.local/share/pnpm/store`) — no
  project-local store, no `.pnpm-home` shims.
