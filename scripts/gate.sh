#!/usr/bin/env bash
# THE gate for this repo — the ONE way to run the suite (AGENTS.md §The gate
# and the clock). A simplified port of Campaigner's gate contract for a fresh
# repo: no chunking, no watchdog (the suite is one file today — add them when
# the suite gets slow, not before).
#
# What it enforces:
#   * ONE suite at a time, via an ATOMIC lock (mkdir). `pgrep` is a snapshot,
#     not a lock: two agents can look in the same instant and both start.
#   * The COMPILE tier takes NO lock, so typecheck-only runs proceed alongside
#     a full one; never stack two full gates.
#   * A docs-only diff (vs HEAD, *.md only) may take the compile tier: lint
#     and typecheck still run, vitest is skipped.
#
# Exit codes: 0 = full gate GREEN · 1 = RED · 2 = compile tier only (NOT
# verified — the suite DID NOT RUN, never report it as "the gate passed") ·
# 9 = the lock is held by another suite (VOID, never a failure).
#
# Usage:
#   scripts/gate.sh                                # FULL: typecheck + eslint + vitest
#   GATE_TESTS=0 scripts/gate.sh                   # COMPILE ONLY: typecheck, no suite
#   GATE_TESTS=0 GATE_CHECKS=all scripts/gate.sh   # compile tier + eslint
#
# Env: GATE_TESTS (1|0, default 1), GATE_CHECKS (typecheck|all, default
#      typecheck — compile tier only; the full run always lints),
#      GATE_LOGDIR (default <repo>/.gate-logs/gate-<pid>-<timestamp> — IN THE
#      WORKSPACE, so the run's evidence outlives the process),
#      GATE_LOCK (default <git-common-dir>/.imager-lock — the ONE suite lock,
#      on a path shared by every shell and every future worktree).
set -uo pipefail

# pnpm runs a deps PREFLIGHT before every script that can abort in a
# non-interactive harness; CI=true is pnpm's own documented switch for a
# non-interactive run. No test in this repo reads process.env.CI.
export CI="${CI:-true}"

cd "$(git rev-parse --show-toplevel)" || exit 2

LOGDIR="${GATE_LOGDIR:-$PWD/.gate-logs/gate-$$-$(date -u +%Y%m%dT%H%M%S)}"
mkdir -p "$LOGDIR"
RAW="$LOGDIR/raw.log"

# The lock MUST be on a path shared by every shell AND every future worktree.
# `git rev-parse --git-common-dir` is the ONE path identical in both (the main
# tree's .git), giving <repo>/.imager-lock everywhere. GATE_LOCK overrides.
_common="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
case "$_common" in /*) ;; *) _common="$PWD/$_common" ;; esac
LOCK_BASE="$(dirname "$_common")"
[ -d "$LOCK_BASE" ] || LOCK_BASE="$PWD"
LOCK="${GATE_LOCK:-$LOCK_BASE/.imager-lock}"

GATE_TESTS="${GATE_TESTS:-1}"
GATE_CHECKS="${GATE_CHECKS:-typecheck}"

log() {
  echo "$@" | tee -a "$RAW"
}

# Docs-only predicate: every file changed vs HEAD (tracked diff PLUS untracked
# files) ends in .md. With no HEAD yet (nothing committed) there is no base to
# diff against, so the answer is "not docs-only" — run everything.
is_docs_only() {
  git rev-parse --verify HEAD >/dev/null 2>&1 || return 1
  local files
  files="$(git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard)"
  [ -n "$files" ] || return 1
  while IFS= read -r f; do
    case "$f" in
      *.md) ;;
      *) return 1 ;;
    esac
  done <<< "$files"
  return 0
}

run_typecheck() {
  log "=== typecheck ==="
  if pnpm exec tsc -b >>"$RAW" 2>&1; then
    log "typecheck: PASS"
    return 0
  fi
  log "TYPECHECK FAILED (see $RAW)"
  return 1
}

run_eslint() {
  log "=== eslint ==="
  if pnpm exec eslint . >>"$RAW" 2>&1; then
    log "eslint: PASS"
    return 0
  fi
  log "ESLINT FAILED (see $RAW)"
  return 1
}

# --- Compile tier: no lock, no suite, exit 2 on success. ---
if [ "$GATE_TESTS" = "0" ]; then
  log "COMPILE TIER (GATE_TESTS=0): typecheck$([ "$GATE_CHECKS" = "all" ] && echo " + eslint") — the suite DID NOT RUN. Exit 2 is NOT a green gate."
  fail=0
  run_typecheck || fail=1
  if [ "$GATE_CHECKS" = "all" ]; then
    run_eslint || fail=1
  fi
  if [ "$fail" = "0" ]; then
    log "COMPILE TIER CLEAN — exit 2 (suite did not run)"
    exit 2
  fi
  log "COMPILE TIER RED — exit 1"
  exit 1
fi

# --- Full run: docs-only diffs drop to the compile tier (no lock needed). ---
if is_docs_only; then
  log "DOCS-ONLY diff vs HEAD (*.md only): compile tier answers the question — suite skipped."
  fail=0
  run_typecheck || fail=1
  if [ "$GATE_CHECKS" = "all" ]; then
    run_eslint || fail=1
  fi
  if [ "$fail" = "0" ]; then
    log "COMPILE TIER CLEAN (docs-only) — exit 2 (suite did not run)"
    exit 2
  fi
  log "COMPILE TIER RED (docs-only) — exit 1"
  exit 1
fi

# --- Full run takes the atomic lock. ---
if mkdir "$LOCK" 2>/dev/null; then
  echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ) $PWD" > "$LOCK/owner"
  trap 'rm -rf "$LOCK"' EXIT
  log "lock: acquired $LOCK"
else
  # Held. Stale = older than 30 minutes AND no suite process alive: a killed
  # run. Reap the STALE lock only; a live one refuses with exit 9.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ] && ! pgrep -f "^[^ ]*node[^ ]* .*vites[t]" >/dev/null 2>&1; then
    log "lock: STALE (older than 30 min, no suite alive) — removing and proceeding"
    rm -rf "$LOCK"
    if mkdir "$LOCK" 2>/dev/null; then
      echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ) $PWD" > "$LOCK/owner"
      trap 'rm -rf "$LOCK"' EXIT
      log "lock: acquired $LOCK (after stale reclamation)"
    else
      log "lock: HELD by another suite ($LOCK) — VOID, exit 9"
      exit 9
    fi
  else
    log "lock: HELD by another suite ($LOCK) — VOID, exit 9"
    exit 9
  fi
fi

# Refuse while a FOREIGN suite (one that does not know our lock) runs — wait
# for it, never reap it.
if pgrep -f "^[^ ]*node[^ ]* .*vites[t]" >/dev/null 2>&1; then
  foreign="$(pgrep -af "^[^ ]*node[^ ]* .*vites[t]")"
  log "foreign suite alive — VOID, exit 9 (wait and retry):"
  log "$foreign"
  exit 9
fi

log "=== FULL GATE ==="
fail=0
run_typecheck || fail=1
run_eslint || fail=1

log "=== vitest run ==="
if pnpm exec vitest run >>"$RAW" 2>&1; then
  log "vitest: PASS"
else
  log "VITEST FAILED (see $RAW)"
  fail=1
fi

# Summed counts, quoted from the raw log (each summary line kept whole).
files_line="$(grep -E 'Test Files.*[0-9]+' "$RAW" | awk 'END{print}')"
tests_line="$(grep -E 'Tests.*[0-9]+' "$RAW" | awk 'END{print}')"
log "--- summary ---"
log "${files_line:-Test Files: (no summary found)}"
log "${tests_line:-Tests: (no summary found)}"
log "raw log: $RAW"

if [ "$fail" = "0" ]; then
  log "GATE GREEN — exit 0"
  exit 0
fi
log "GATE RED — exit 1"
exit 1
