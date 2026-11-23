# Sandbox Efficiency, Concurrency, and Async Jobs Implementation Plan

> **For agentic workers:** Executing inline with `superpowers:executing-plans` (authorized by user) and `superpowers:test-driven-development`, followed by one fresh whole-branch review and disposable `opencode/hy4-flash-free` verification.

**Goal:** Eliminate sandbox blocking, lost truncated logs, crash-wedged workspace locks, slow synchronous tree walks, and boundary retry loops while keeping strict fail-closed OS containment and per-command `ask` host escapes.

**Architecture:** Move host-trusted coordination state (`<hash>.coord.lock`, `<hash>.leases.json`, `<hash>.logs/`) directly under `<scratchRoot>` (outside writable `<scratch>`), convert `gitTreeMounts()` to async `dirent`-based inspection, add a safe `/tmp/opencode` mount bridge, add a compact `jobs.mjs` manager for `sandbox_shell({ background: true })` and `sandbox_job`, and align native project-config `edit` (`ask`) + expanded `restrictionHint` in `policy.mjs`/`index.js`/`config.mjs`.

**Tech Stack:** Node.js 22+ ESM, Linux bubblewrap 0.13.1, native x86-64 seccomp BPF, Node test runner, Python 3 OpenCode integration harness.

**Spec:** `docs/superpowers/specs/2026-11-23-sandbox-efficiency-and-jobs-design.md`

## Global Constraints

- Linux x86-64 only; preserve all existing OS containment (no network, read-only `.git`, seccomp BPF, masked `privatePaths()`, pinned Planner `--bind-fd`).
- Host-trusted state (`leases.json`, `coord.lock`, `logs/`) MUST stay outside the writable `--bind <scratch> <scratch>` mount.
- Every `shell_unsandboxed` call still requires per-command `ask` (or stays `deny`); no session-scoped escape memory.
- Keep `kit/install.mjs` `CODE` and `package.json` `files` updated for any new runtime file (`jobs.mjs`).
- All existing unit tests, real `bwrap` tests, real OpenCode integration tests, and packaged `doctor --full` must pass; record real `opencode/hy4-flash-free` verification separately.

## Review Focus

1. Concurrent writable `sandbox_shell` startups racing on the same workspace coord lock: both succeed and clean up all placeholders without leaking files.
2. Dead-PID coord lock + dead-PID lease + stale `0444`/`0555` placeholders alongside a user-modified file at a reserved path: automatic recovery removes unchanged placeholders and preserves the user-modified file.
3. Foreground log spillover triggered by either >2,000 short lines (<50 KB) OR >50 KB single line: saved log contains exact complete output from byte 0 (capped at 10 MiB).
4. Sandboxed command attempting to read or tamper with `<scratchRoot>/<hash>.leases.json` or `<scratchRoot>/<hash>.logs/` via `/tmp/opencode/sandbox/...`: blocked by `--tmpfs <scratchRoot> --remount-ro <scratchRoot>`.
5. `sandbox_job` cross-session isolation (Session B cannot see/cancel Session A's job) and plugin `close()` tearing down active background process groups and releasing all placeholders.

---

### Task 1: Ref-counted leases, async `gitTreeMounts`, `/tmp/opencode` bridge, env caches, and foreground log spillover

**Files:**
- Modify: `sandbox.mjs`
- Test: `test/sandbox.test.mjs`

**Interfaces:**
- Produces in `sandbox.mjs`:
  - `workspaceHash(workspace)` -> 16-char sha256 hex string
  - `activePlaceholders(workspace, scratchRoot)` -> array of active placeholder file paths for live leases (sync, read-only, tolerates missing file)
  - `inspectScratchHealth(scratchRoot)` -> `{ ok: boolean, staleLocks: number, staleLeases: number, activeLeases: number, detail: string }`
  - `pruneWorkspaceLogs(logDir, activePaths, limit = 32)` -> deletes oldest completed logs beyond `limit`
  - `runProcess(file, args, options)` -> adds optional `logFile` (eager stream) or `spillLog` (`() => string`, lazy spillover once >50 KB or >2,000 lines), `maxLogBytes = 10 * 1024 * 1024`, `onTail`; returns `{ content, exit_code, truncated, log_path? }`
  - `spawnSandbox(options)` -> async setup returning `{ child, scratch, logPath, release(), ... }` (supports `nativeTempRoot`, `readOnly`, `writablePaths`, `logFile`, `spillLog`)
  - `runSandbox(options)` -> backward-compatible foreground runner returning `{ content, exit_code, truncated, scratch, log_path? }`

- [ ] **Step 1:** Write failing tests in `test/sandbox.test.mjs` covering:
  - Foreground truncation (>2000 short lines and >50 KB) spills complete output from byte 0 to `<scratchRoot>/<hash>.logs/<id>.log` (0600) and returns `log_path`; small commands create no log file; log rotation keeps <=32 completed logs.
  - Parallel read-only commands run concurrently while a writable command is sleeping (no serialization), and two concurrent writable commands share ref-counted placeholders cleanly without leaving leftovers or polluting `git status`.
  - Dead-PID coord lock + dead-PID lease + stale placeholder recover automatically while preserving any user-modified file.
  - Async `gitTreeMounts` scans `node_modules` once without issuing redundant `lstatSync` calls on non-reserved directories.
  - Safe `/tmp/opencode` bridge exposes files in `nativeTempRoot` inside `sandbox_shell` while masking `<scratchRoot>` (`<hash>.leases.json`, `<hash>.logs/`, sibling scratches) and hiding host `/tmp` sockets.
  - `cleanEnvironment()` sets `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPYCACHEPREFIX`, `RUFF_CACHE_DIR`, `MYPY_CACHE_DIR` under scratch and passes through safe toolchain vars (while still stripping secret-named vars).
- [ ] **Step 2:** Run `node --test test/sandbox.test.mjs` and confirm new tests FAIL.
- [ ] **Step 3:** Implement the host-trusted lease/coord lock, async `gitTreeMounts`, `/tmp/.opencode-git-excludes`, `/tmp/opencode` bridge, `cleanEnvironment()` additions, `runProcess` spillover, `spawnSandbox`, `activePlaceholders`, and `inspectScratchHealth` in `sandbox.mjs`.
- [ ] **Step 4:** Run `node --test test/sandbox.test.mjs`; confirm all existing and new tests PASS.
- [ ] **Step 5:** Commit Task 1.

---

### Task 2: Async background job manager (`jobs.mjs`)

**Files:**
- Create: `jobs.mjs`
- Modify: `kit/install.mjs` (`CODE` list), `package.json` (`files` list)
- Test: `test/jobs.test.mjs`

**Interfaces:**
- Consumes: `spawnSandbox`, `workspaceHash`, `pruneWorkspaceLogs` from `./sandbox.mjs`
- Produces in `jobs.mjs`:
  - `createJobManager(options)` returning `{ start, list, status, wait, cancel, cleanupSession, close }`
  - Limits: `maxPerWorkspace = 8`, `maxGlobal = 16`, `maxCompletedPerSession = 32`, `graceMs = 1000`, `defaultBackgroundTimeout = 600000`, `maxBackgroundTimeout = 1800000`

- [ ] **Step 1:** Write failing tests in `test/jobs.test.mjs` covering:
  - Fast `background: true` command exiting within `graceMs` returns completed inline result directly without leaving a running job.
  - Slow `background: true` command returns `{ background: true, job_id, status: 'running', log_path }`, lets another `sandbox_shell` run concurrently in the same workspace, streams output to `log_path`, and completes via `wait` / `status`.
  - Aborting `signal` during the `graceMs` window kills the process group (`exit_code: 130`) and releases its lease; aborting `wait` later does NOT kill the job.
  - `cancel` kills `-child.pid`, releases placeholders, sets `status: 'cancelled'` (`exit_code: 130`).
  - `timeout: 0` is rejected for background jobs; max runtime kills the process group (`status: 'timed_out'`, `exit_code: 124`).
  - Cross-session isolation (Session B cannot see/status/wait/cancel Session A's job) and per-workspace concurrency limit enforcement.
  - `cleanupSession(sessionID)` and `close()` terminate all active background jobs and release all placeholders.
- [ ] **Step 2:** Run `node --test test/jobs.test.mjs` and confirm it FAILS.
- [ ] **Step 3:** Implement `jobs.mjs` and add `'jobs.mjs'` to `kit/install.mjs` `CODE` and `package.json` `files`.
- [ ] **Step 4:** Run `node --test test/jobs.test.mjs`; confirm PASS.
- [ ] **Step 5:** Commit Task 2.

---

### Task 3: Policy, config, and plugin wiring (`policy.mjs`, `config.mjs`, `index.js`)

**Files:**
- Modify: `policy.mjs`, `config.mjs`, `index.js`
- Test: `test/policy.test.mjs`, `test/config.test.mjs`, `test/plugin.test.mjs`

**Interfaces:**
- Produces in `policy.mjs`: `GIT_RESERVED`, `CONFIG_RESERVED`, `isProjectConfigEdit(target, workspace)`
- Produces in `config.mjs`: mirrors global `sandbox_job: allow` and per-agent `shell: deny` / `!access.shell` denials onto `sandbox_job`
- Produces in `index.js`:
  - `sandbox_shell` optional `background: boolean`, foreground `[full output saved to ...]` notice, `nativeTempRoot` pass-through
  - `sandbox_job` tool (`action: 'list' | 'status' | 'wait' | 'cancel'`, `job_id?`, `wait_ms?`) gated by `access.shell` and scoped to `tool.sessionID`
  - Plugin `setup(ctx)` returns async cleanup function calling `jobs.close()` and subscribes to `session.deleted` if `ctx.event?.subscribe` exists
  - `permission:evaluate`: `workspace-write` native `edit` on `CONFIG_RESERVED` checks `activePlaceholders()` first (deny with actionable message if held), else forces `ask` (preserving explicit `deny`); `.git` stays hard-denied; `external_directory` resolves against `scope.directory`
  - Expanded category-specific `restrictionHint` (DNS/network, Git `.git`, read-only/permission)

- [ ] **Step 1:** Write failing tests in `test/policy.test.mjs`, `test/config.test.mjs`, and `test/plugin.test.mjs` covering:
  - `isProjectConfigEdit` returns true for `opencode.json`, `.opencode/x`, `.agents/x`, `.claude/x`, `.mcp.json` inside workspace, false for `.git/config` and outside workspace.
  - `config.mjs` allows `sandbox_job` globally and denies `sandbox_job` when `shell` is denied or `!access.shell`.
  - `index.js` `edit` evaluation: `workspace-write` on `opencode.json`/`.claude/settings.json` becomes `ask` (preserving `deny`); `.git/config`, `planner`, `read-only`, and `nativeTempRoot/opencode.json` stay `deny`; overlapping active background placeholder denies upfront with actionable `sandbox_job` message.
  - `index.js` `external_directory` resolves relative resources against `scope.directory`.
  - `restrictionHint` triggers on `ENOTFOUND`, `EAI_AGAIN`, `Temporary failure in name resolution`, `ECONNREFUSED`, `EROFS`, and `.git/index.lock` errors with targeted hints, without triggering on ordinary test failures.
  - `sandbox_shell({ background: true })` + `sandbox_job` (`list`, `status`, `wait`, `cancel`) + `shell: false` denial + cross-session isolation + plugin teardown cleanup + foreground spillover `[full output saved to ...]`.
- [ ] **Step 2:** Run `node --test test/policy.test.mjs test/config.test.mjs test/plugin.test.mjs`; confirm new tests FAIL.
- [ ] **Step 3:** Implement changes in `policy.mjs`, `config.mjs`, and `index.js`.
- [ ] **Step 4:** Run `node --test test/policy.test.mjs test/config.test.mjs test/plugin.test.mjs`; confirm PASS.
- [ ] **Step 5:** Commit Task 3.

---

### Task 4: Doctor diagnostics, agent/README docs, OpenCode integration tests, and real-model verification

**Files:**
- Modify: `kit/doctor.mjs`, `packs/deniz-agents/agents/build.md`, `README.md`, `test/opencode_integration.py`
- Test: `test/cli.test.mjs`, `test/opencode_integration.py`, `npm test`

**Interfaces:**
- Consumes: `inspectScratchHealth` from `../sandbox.mjs` in `kit/doctor.mjs`

- [ ] **Step 1:** Add failing tests in `test/cli.test.mjs` / `test/opencode_integration.py` for:
  - `doctor` scratch/lock health check (reports stale lease cleanly with `okay: true` and detail; fails only on unsafe `scratchRoot`).
  - Real OpenCode integration tests:
    - `sandbox_shell({ background: true })` + `sandbox_job` (`status`/`wait`/`cancel`) + parallel read-only command while background writer runs.
    - Truncated foreground `sandbox_shell` output saves full log readable via native `read`.
    - Native `write` under `/tmp/opencode/...` is readable at the same path inside `sandbox_shell` (while sibling scratch/leases stay hidden).
    - Project config native `edit` prompts `ask` (and denies upfront while an active background job holds its placeholder).
    - `sandbox_job` is denied for a `shell: false` agent.
- [ ] **Step 2:** Run targeted tests to confirm RED.
- [ ] **Step 3:** Update `kit/doctor.mjs`, `packs/deniz-agents/agents/build.md`, and `README.md`.
- [ ] **Step 4:** Run full `npm test` (including `test/package.test.mjs` with packaged `doctor --full`) and `npm run test:opencode`; confirm 0 failures.
- [ ] **Step 5:** Commit Task 4.
- [ ] **Step 6:** Dispatch one fresh whole-branch code reviewer subagent; fix any Critical/Important findings via TDD in one pass; re-run full `npm test`.
- [ ] **Step 7:** Run disposable real-model verification with `opencode/hy4-flash-free` (exercising background job + `sandbox_job` + truncated log inspection) and record results separately from scripted tests.
