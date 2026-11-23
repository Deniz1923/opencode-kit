# Sandbox Efficiency, Concurrency, and Async Jobs

Status: proposed design for approval.

## Intent and Why

Deniz wants the OpenCode Kit permission and sandbox layer to maximize **agent efficiency**—eliminating wasted turns, blocked subagents, lost command output, slow per-command startup, and dead-end boundary retry loops—while keeping the existing strict fail-closed OS sandbox and per-command `ask` escape behavior intact.

Today, several friction points in `sandbox.mjs`, `index.js`, `policy.mjs`, and `config.mjs` slow down normal coding sessions:

- Long commands (>120s) or background dev servers block the model turn until `SIGKILL` (exit 124).
- Truncated output (>50 KB / 2,000 lines) discards the middle permanently, forcing the agent to re-run commands just to inspect earlier errors.
- A single exclusive lock per workspace serializes even read-only subagents (`explore`, `code-reviewer`, `debugger`, `test-engineer`) behind any running `build` command, and never self-recovers after an abrupt process crash.
- Every writable `sandbox_shell` call synchronously walks the entire workspace tree (including `node_modules`/`.venv`/`target`) and runs 7 `lstatSync` calls per directory, blocking OpenCode's server event loop.
- Native tools read/write `/tmp/opencode` while `sandbox_shell` gets an empty ephemeral `/tmp`, breaking file handoffs across tools.
- `config.mjs` specifies `ask` for native edits to project config files (`opencode.json`, `.opencode`, `.agents`, `.claude`, `.mcp.json`), but `policy.mjs` (`canEdit`) hard-denies them, causing multi-turn dead ends.
- `restrictionHint` misses common DNS/network/Git error strings (`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `Temporary failure in name resolution`, `EROFS`), and `cleanEnvironment()` omits scratch-backed linter/Python cache variables and safe toolchain path variables, causing unnecessary failures inside read-only workspaces.

## Goals

1. **Full log persistence without re-running commands:** Stream full combined output to a bounded private scratch log whenever foreground output truncates, and for all background jobs. Return the log path so the agent inspects it with `read`/`grep`.
2. **True concurrency and crash-safe locking:** Replace the whole-command exclusive workspace lock with a short-lived PID-tracked coordination lock plus ref-counted per-path placeholder leases. Read-only commands run concurrently without blocking on writers; overlapping writable/background commands share ref-counted placeholders cleanly; dead-PID leases and unchanged orphan placeholders recover automatically.
3. **Fast, non-blocking workspace scanning:** Make `gitTreeMounts()` asynchronous and inspect `dirent` entries directly instead of running 7 redundant `lstatSync` calls per directory, while preserving full nested config and Git protection (including inside `node_modules`).
4. **Lightweight async/background sandbox jobs:** Add optional `background: true` to `sandbox_shell` plus one compact `sandbox_job` tool (`list`, `status`, `wait`, `cancel`) with minimal tool-schema overhead, bounded concurrency, max-runtime caps, and automatic process-group teardown on cancel, session deletion, or plugin unload.
5. **Eliminate boundary retry loops:**
   - Bridge user-owned safe `/tmp/opencode` into `sandbox_shell` while keeping host `/tmp` hidden and re-masking `scratchRoot` so locks and other workspaces' scratch directories stay isolated.
   - Align native `edit` evaluation with `config.mjs`: allow `workspace-write` agents to prompt (`ask`) on project config/agent files inside approved workspaces while keeping `.git`, global configs, `nativeTempRoot` reserved filenames, `planner`, and `read-only` hard-denied.
   - Expand `restrictionHint` to cover common DNS, network, socket, filesystem, and Git metadata errors with concise failure-specific next steps.
   - Add safe scratch-backed cache env vars and pass through safe read-only toolchain locator env vars in `cleanEnvironment()`.
   - Resolve `external_directory` resources against `scope.directory` in `index.js`.
   - Report stale workspace locks and active leases in `kit/doctor.mjs`.

## Non-Goals

- **No session-scoped or remembered `shell_unsandboxed` approvals.** Every host escape still prompts `ask` (or stays `deny`).
- **No weakening of OS sandbox boundaries.** Network stays disabled, `.git` metadata stays read-only, host `/tmp` sockets stay hidden, seccomp BPF stays unchanged, and `mcp:*` / native `shell` hard denials stay unchanged.
- **No background mode for `shell_unsandboxed`.** Host escapes remain synchronous and explicit.
- **No cross-session job access or durable job survival across OpenCode restarts.** Background jobs belong to their owning session and are terminated on plugin unload.
- **Unrelated bugs out of scope for this spec:** `cli.mjs` custom-namespace `update` preservation and `integrations/usage/collector.mjs` compaction `modelMs` snapshot timing will be handled separately.

## Anti-Goals

- Adding multiple verbose tool schemas that inflate every model request.
- Leaving zombie `bwrap` process groups running after cancellation, timeout, session deletion, or plugin unload.
- Allowing a crashed process to permanently brick `sandbox_shell` for a workspace.
- Silently weakening nested `.git` or config protection (e.g., skipping `node_modules` during scans).
- Breaking existing synchronous `sandbox_shell` timeout semantics (`exit_code: 124`, no delayed file creation).

## Constraints

- Linux x86-64, Node.js 22+, bubblewrap 0.13.1, OpenCode 2.1.3–2.3.2 (tested live on 2.3.2).
- Preserve backward compatibility for existing `sandbox_shell` callers (`background` defaults to `false`).
- Keep `kit/install.mjs` `CODE` list and `package.json` `files` array synchronized if a new runtime module (e.g. `jobs.mjs`) is introduced.
- Keep `test/sandbox.test.mjs`, `test/plugin.test.mjs`, `test/config.test.mjs`, `test/opencode_integration.py`, and packaged `doctor --full` passing; verify real-model behavior separately with `opencode/hy4-flash-free` in disposable sessions.

## Approaches Considered

### Approach A — Focused Efficiency Upgrade (No New Tools)
Keep the existing 3-tool surface (`sandbox_shell`, `shell_unsandboxed`, `workspace_approve`) and implement log spillover, ref-counted crash-safe locking, async `gitTreeMounts`, the `/tmp/opencode` bridge, native project-config `ask` alignment, expanded `restrictionHint`, and toolchain env vars.
- *Trade-off:* Zero extra tool-schema tokens and smallest diff, but long builds (>120s) and background dev servers still block synchronously until timeout.

### Approach B — Full Execution Upgrade + Async Sandbox Jobs *(Selected)*
Includes everything in Approach A, plus `background: true` on `sandbox_shell` and one compact `sandbox_job` tool (`list`, `status`, `wait`, `cancel`) backed by the same ref-counted placeholder and scratch-log infrastructure.
- *Trade-off:* Adds one compact tool schema and job lifecycle management, while permanently eliminating long-command timeouts, lost logs, and blocked subagents/dev servers.

### Approach C — Capability-Relaxed Sandbox *(Rejected)*
Carve writable access to `.git/index`+`objects` or share host loopback networking inside `sandbox_shell`.
- *Why rejected:* Contradicts keeping the default `ask` boundary strict; Git internals and host loopback (including OpenCode's own local API server) introduce disproportionate security complexity.

**Decision:** Deniz selected **Approach B** (strict `ask` preserved; full execution, concurrency, logging, hint, and async job improvements).

## Design

### 1. Ref-Counted Workspace Leases, Placeholders, and Crash Recovery (`sandbox.mjs`)

Replace the whole-command queue and unrecoverable `<scratchRoot>/<hash>.lock` file with host-trusted coordination files stored **directly under `<scratchRoot>` (outside `<scratch>`)**, so they are masked by `--tmpfs <scratchRoot> --remount-ro <scratchRoot>` and completely unreachable from inside any sandboxed command:

- **Short-lived coordination lock (`<scratchRoot>/<hash>.coord.lock`):**
  - Acquired with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` (`0600`), writing JSON `{ pid, createdAt }`.
  - Held **only** during the brief setup and teardown critical sections (updating leases and creating/removing placeholders)—never while the sandboxed command runs.
  - Contention retry: short backoff (up to 5s). If an existing lock's `pid` is dead (`process.kill(pid, 0)` throws `ESRCH`), unlink and reacquire cleanly. If a legacy `<scratchRoot>/<hash>.lock` exists (empty file from an older version), clean it under the coord lock if empty/unused.
- **Host-trusted lease registry (`<scratchRoot>/<hash>.leases.json`, `0600`, atomic rename):**
  - Lives outside `<scratch>` so no sandboxed process can read, forge, symlink, or delete lease records.
  - Maps `leaseId -> { pid, createdAt, placeholders: [{ file, kind, ino, dev }] }`.
  - **Acquire (writable workspaces only):** Under coord lock, prune any lease whose `pid` is dead (`ESRCH`) and safely remove any placeholder whose refcount drops to 0 (verifying `lstatSync` `ino`/`dev` and, for files, exact `'{}\n'` content—never touching user-modified files). For each placeholder required by this invocation (at `workspace`, `cwd`, or nested config dirs), reuse an already-tracked live placeholder or create a new one (`0444` file / `0555` dir) and record `{ file, kind, ino, dev }`. Write updated `<hash>.leases.json`.
  - **Release (writable workspaces only):** Under coord lock, delete `leaseId`; for each placeholder no longer referenced by any live lease, remove it after verifying `ino`/`dev`/content.
  - **Read-only invocations (`readOnly: true && writablePaths.length === 0`):** Take no writable lease and create no placeholders. They run fully in parallel with writers and with each other. Before spawning, they read currently tracked placeholder paths (if `<hash>.leases.json` exists) to pass into `OPENCODE_PLACEHOLDER_IGNORE` so `git status` stays clean even while a writable command runs concurrently.
  - **Planner invocations (`readOnly: true && writablePaths.length > 0`):** Continue creating validated planning roots inside a confined preparation `bwrap` and mounting pinned `O_DIRECTORY | O_NOFOLLOW` descriptors via `--bind-fd`. They do not block read-only or writable runs outside their own setup.
  - **Per-invocation git excludes:** Write the temporary git-excludes file inside each invocation's private ephemeral `/tmp` (`/tmp/.opencode-git-excludes`) from the in-sandbox bootstrap script instead of `<scratch>/run/`. Each `bwrap` gets its own private `--tmpfs /tmp`, eliminating both concurrent collisions and host-side cleanup.

### 2. Async, Low-Syscall `gitTreeMounts()` (`sandbox.mjs`)

- Convert `gitTreeMounts()` to an `async` traversal using `fs.promises.readdir(dir, { withFileTypes: true })` with bounded concurrency (builder's choice, e.g. 16).
- Check `entry.name` against `RESERVED` directly from `dirent` objects:
  - Do **not** issue 7 `lstatSync` calls on directories that contain no `RESERVED` entries.
  - Only call `lstat` on entries that match `RESERVED` (rejecting symlinks via `entry.isSymbolicLink()` or `lstat` fallback if `dirent` type is unknown).
  - Still traverse every non-reserved subdirectory (including `node_modules`) exactly once so nested `.git` and config files remain protected and existing regression tests continue to pass.
- Placeholder creation for `workspace`, `cwd`, and directories containing any `RESERVED` entry runs through the lease manager above.

### 3. Safe `/tmp/opencode` Bridge (`sandbox.mjs` + `index.js`)

In `executeSandbox`, accept an optional `nativeTempRoot` (default `/tmp/opencode`, passed from `createPlugin`):

1. Always mount `--tmpfs /tmp` first (host `/tmp` files and Unix sockets remain hidden).
2. If `nativeTempRoot` exists and passes the strict ownership/mode check (`lstatSync`: real directory, not symlink, `uid === process.getuid()`, `!(mode & 0o022)`) and `nativeTempRoot !== scratchRoot`:
   - Mount `nativeTempRoot` as `--bind` when `writable` is true, or `--ro-bind` otherwise.
   - If `inside(scratchRoot, nativeTempRoot)` (the default `/tmp/opencode/sandbox` inside `/tmp/opencode`), immediately overlay `--tmpfs <scratchRoot> --remount-ro <scratchRoot>` so all lock files and other workspaces' scratch directories are masked.
   - Note: `nativeTempRoot` reserved config filenames (`opencode.json`, etc.) stay outside workspace trust because global plugin allowlists and `mcp:*` denials remain enforced.
3. Finally, mount `--bind <scratch> <scratch>` (and ensure scratch subdirs exist) so **only** the active workspace's private scratch is writable at `<scratch>`.

Result: native `write`/`edit`/`read` on `/tmp/opencode/...` and `sandbox_shell` see the exact same path, `$TMPDIR` still points to `<scratch>/tmp`, and host `/tmp` sockets plus sibling workspace scratches remain completely isolated.

### 4. Output Log Spillover & Async Job Lifecycle (`sandbox.mjs`, `jobs.mjs`, `index.js`)

Host-managed command logs are stored at `<scratchRoot>/<hash>.logs/<id>.log` (`0700` dir, `0600` files)—outside the writable `<scratch>` mount so sandboxed commands cannot tamper with or symlink-swap log paths, while remaining directly readable by native `read`/`grep` (already allowed under `scratchRoot` / `/tmp`).

#### Foreground Output Spillover
- Keep the existing inline buffer (10 KB head + 40 KB tail, max 2,000 lines, `[truncated]` marker).
- When a foreground command's combined stdout+stderr would exceed the inline cap (either byte cap or line cap), lazily create `<scratchRoot>/<hash>.logs/<id>.log` (`0600`), flush already-buffered bytes in exact arrival order (by keeping a small sequential pre-spill buffer up to the spill threshold—e.g. 50 KB / 2,000 lines—before switching to head+tail + file stream), and stream all subsequent output to the log file up to a **10 MB per-log cap** (appending `[log truncated at 10 MiB]` if exceeded).
- Fast commands under the inline limit perform **zero** log-file I/O.
- When truncated, include `log_path` in tool metadata and append `\n[full output saved to <log_path>; inspect with read/grep instead of re-running]` to tool content.
- Rolling cleanup in `<scratchRoot>/<hash>.logs/`: retain at most 32 completed log files per workspace, deleting oldest first and never deleting an active job's log.

#### Background Mode on `sandbox_shell`
- Add optional `background: boolean` (default `false`) to `sandbox_shell` input schema.
- When `background: true`:
  - `timeout` specifies the job's max runtime in milliseconds: default `600000` (10 min), capped at `1800000` (30 min); `timeout: 0` is rejected for background jobs so jobs cannot run indefinitely.
  - Always stream full combined output to `<scratchRoot>/<hash>.logs/<job_id>.log` (up to 10 MB cap) while retaining a small rolling tail in memory (4 KB) for instant status checks.
  - Enforce concurrency limits: max **8 active background jobs per workspace** and **16 per plugin instance** (fail with a clear error asking the agent to wait/cancel existing jobs if full).
  - Wait up to a short initial grace period (`1000ms`) before detaching the response:
    - If `tool.signal` aborts *during* this initial grace period (before returning a `job_id`), kill the process group (`exit_code: 130`), release its lease, and return `[cancelled]`—never leaking an orphaned job whose `job_id` the caller never received.
    - If the command exits within `1000ms`, return the normal completed result directly (including `exit_code`, inline output, `restrictionHint` if applicable, and `log_path` if truncated)—saving a follow-up `sandbox_job` turn.
    - Otherwise return `{ status: 'running', job_id, log_path, workspace, cwd }` with a concise message pointing to `sandbox_job` and `read`/`grep` on `log_path`.
  - After returning `{ status: 'running', job_id, ... }`, the initiating call's `tool.signal` no longer affects the background job. The job runs until normal exit, max-runtime timeout (`exit_code: 124`), explicit `sandbox_job(cancel)` (`exit_code: 130`), session deletion, or plugin unload.

#### Compact `sandbox_job` Tool (`index.js` + `jobs.mjs`)
- Schema (`codemode: false`, `additionalProperties: false`):
  - `action`: `'list' | 'status' | 'wait' | 'cancel'` (required)
  - `job_id`: `string` (required for `status`, `wait`, `cancel`)
  - `wait_ms`: `integer` (`0..60000`, default `10000`, used only by `wait`)
- **Authorization & Scoping:**
  - Enforced by the same trusted policy gate as `sandbox_shell`: `access.shell === true` checked in both `permission:evaluate` and `execute`, plus `ctx.permission.assert({ action: 'sandbox_job', resources: [job_id ?? action], ... })`.
  - `config.mjs` mirrors global `allow` and per-agent `shell: deny` rules onto `sandbox_job` (matching `sandbox_shell`).
  - Jobs are strictly scoped to their owning `sessionID`; another session cannot list, inspect, wait on, or cancel them.
- **Behavior:**
  - `list`: returns active + recently completed jobs (last 32 completed per session) with `job_id`, `status` (`running`|`exited`|`timed_out`|`cancelled`), `exit_code`, `elapsed_ms`, `log_path`, and command preview (first 120 chars).
  - `status`: returns job state, `exit_code`, `elapsed_ms`, `log_path`, `log_bytes`, last 4 KB of output, and `restrictionHint` if finished with a non-zero exit matching a sandbox restriction.
  - `wait`: awaits exit up to `wait_ms` (interruptible by `tool.signal`), returning the same summary as `status` (or full bounded head+tail output if it just finished).
  - `cancel`: kills `-child.pid` with `SIGKILL`, awaits process close and lease cleanup, marks `cancelled` (`exit_code: 130`), and returns the final status + `log_path`.
- **Teardown:**
  - `createPlugin().setup(ctx)` returns an async cleanup function (matching OpenCode V2's plugin teardown contract used by `integrations/usage/index.js`) that kills all active background job process groups and awaits lease/placeholder release.
  - Subscribe to `session.deleted` (when `ctx.event?.subscribe` is available) to cancel and clean up any active jobs belonging to a deleted session.

### 5. Permission & Boundary Friction Fixes (`policy.mjs`, `index.js`, `sandbox.mjs`, `config.mjs`)

- **Native project-config `edit` alignment (`policy.mjs` + `index.js`):**
  - Split `reserved` in `policy.mjs` into `GIT_RESERVED` (`['.git']`) and `CONFIG_RESERVED` (`['.opencode', '.agents', '.claude', '.mcp.json', 'opencode.json', 'opencode.jsonc']`).
  - Keep `canEdit()` returning `false` for all reserved paths so `planner`, `read-only`, and `nativeTempRoot` checks remain strictly denied.
  - Add `isProjectConfigEdit(target, workspace)`: true iff `inside(target, workspace)`, no relative segment is `.git`, and at least one relative segment is in `CONFIG_RESERVED`.
  - In `index.js` `permission:evaluate` for `edit`: when `access.profile === 'workspace-write'`, target is not in `sensitive` or `paths.store`, and `isProjectConfigEdit(target, workspace)` holds for an approved root:
    - First check whether an active live lease in `<scratchRoot>/<hash>.leases.json` currently holds a transient protection placeholder at `target` (or an ancestor of `target`). If so, deny upfront with an actionable message (`'Cannot edit this project config path while an active background sandbox job holds its protection placeholder; wait for or cancel the job via sandbox_job first.'`) so the user is not prompted only to hit `EACCES`.
    - Otherwise, set `event.effect = 'ask'` (never downgrading an explicit `deny`) with message `'Approve editing this project configuration or agent file?'` instead of hard-denying.
- **Resolve `external_directory` against `scope.directory` (`index.js`):**
  - Change `canonicalTarget(r...)` to `canonicalTarget(path.resolve(scope.directory, r...))` while keeping `!sensitive.some(p => inside(target, p))` (preserving `/tmp/*` auto-allow in disposable/test homes where `policyFile` or `XDG_*` lives under `/tmp`, since `read`/`grep`/`glob`/`edit` already enforce sensitive-subdirectory denials).
- **Expanded `restrictionHint` (`index.js`):**
  - Detect and give concise category-specific hints on non-zero exits:
    - **Network/DNS:** `could not resolve host`, `temporary failure in name resolution`, `name or service not known`, `getaddrinfo`, `EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `ECONNREFUSED`, `network is unreachable`, `network is down`, `connection refused`, `failed to lookup address information`, `no route to host`, `address family not supported`, `EAFNOSUPPORT`.
    - **Git metadata writes:** `.git/` combined with `read-only file system`/`EROFS`/`permission denied`/`cannot lock ref`/`unable to create`.
    - **General read-only / permission / sandbox errors:** `read-only file system`, `EROFS`, `operation not permitted`, `EPERM`, `permission denied`, `EACCES`, `sandbox unavailable`.
  - Keep guidance short (1–2 sentences) pointing `escape === 'ask'` agents to `shell_unsandboxed` with exact command + reason, and `escape === 'deny'` agents to stay within allowed paths or explain the requirement.
- **Sandbox-friendly environment (`sandbox.mjs`):**
  - In `cleanEnvironment()`, add scratch-backed write-only cache vars: `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPYCACHEPREFIX=<scratch>/cache/pycache`, `RUFF_CACHE_DIR=<scratch>/cache/ruff`, `MYPY_CACHE_DIR=<scratch>/cache/mypy`.
  - Allowlist read-only toolchain locator vars from host env (still filtered by `!/KEY|TOKEN|SECRET|PASSWORD/i`): `VIRTUAL_ENV`, `RUSTUP_HOME`, `CARGO_HOME`, `GOPATH`, `NVM_DIR`, `FNM_DIR`, `PYENV_ROOT`, `BUN_INSTALL`, `DENO_DIR`, `JAVA_HOME`, `DOTNET_ROOT`.
- **Agent guidance (`packs/deniz-agents/agents/build.md`):**
  - Add 1–2 concise sentences covering `background: true` + `sandbox_job` for long commands/servers and reading saved scratch logs instead of re-running truncated commands.
- **Diagnostics (`kit/doctor.mjs`):**
  - Inspect `policy.scratchRoot` read-only: report `okay: false` only if `scratchRoot` itself has unsafe ownership/mode/symlink; report stale coordination locks, legacy `.lock` files, or dead-PID leases as `okay: true` with clear diagnostic detail (noting they self-recover on the next `sandbox_shell` invocation, so `doctor --full` and packaged tests are never wedged by stale crash state).

## Builder Check

One fresh reviewer checked the draft design before handoff. Five concrete findings were resolved directly in this spec:
1. Moved `leases.json` and `logs/` out of the writable `<scratch>` mount to `<scratchRoot>/<hash>.leases.json` and `<scratchRoot>/<hash>.logs/`, and moved `git-excludes` into each command's private ephemeral `/tmp`—preventing sandboxed commands from forging leases or symlink-swapping logs.
2. Preserved `external_directory`'s `!sensitive.some(p => inside(target, p))` predicate (resolving against `scope.directory`) so `/tmp/*` auto-allow keeps working in disposable/test homes while `read`/`grep`/`glob`/`edit` enforce nested sensitive-path denials.
3. Kept stale lock/lease reporting in `doctor` non-failing (`okay: true` with detail) since recovery is automatic on the next `sandbox_shell` call, failing only on unsafe `scratchRoot` ownership/mode/symlinks.
4. Clarified that aborting `tool.signal` *during* the `1000ms` background grace window kills the job (`exit_code: 130`) so no unreferenced orphan job leaks before a `job_id` is returned.
5. Added an active-placeholder check on `edit` for `CONFIG_RESERVED` paths so an edit overlapping a running background job fails fast with an actionable `sandbox_job` message instead of prompting and hitting `EACCES`.

## Left to the Builder

- Exact job ID format (`job_<short-hex>`), backoff timings for the short coord lock, internal helper decomposition (`jobs.mjs` vs. functions inside `sandbox.mjs`), and exact formatting of `sandbox_job` status tables.
- Exact test organization across `test/sandbox.test.mjs`, `test/plugin.test.mjs`, `test/policy.test.mjs`, `test/config.test.mjs`, and `test/opencode_integration.py`.
- Checking whether OpenCode 2.3.2's `FileAccess.resolve` expands `~` on `read`/`edit`/`grep`/`glob` during implementation and adding tilde expansion in `index.js` if so.
