# Verification and review

Verified on this host: OpenCode v2.1.3, bubblewrap 0.13.1, Node v26.12.1,
Linux x86-64. Implementation is staged, not globally installed.

## Commands actually run

- `npm test`: **22 tests passed**, no failures. Includes real bwrap tests,
  filesystem and symlink containment, native socket filtering, actual npm test
  execution inside bwrap, linked worktree reads/write denial, clean Git status,
  known credentials and environment masking, child-process timeout, permission
  order, requested escape cwd, native agent restrictions and migration.
- `python3 test/opencode_integration.py`: **11 tests passed**, no failures.
  These run the installed OpenCode with isolated config/data/state and a local
  scripted model. They cover sandbox execution, host write denial, required
  approval even when permission says allow, rejection, one-time approval,
  explicit deny, plugin absence, deliberate plugin load failure, hostile project
  policy override, hostile project plugin import, session move and the current
  goal/Superpowers plugin packages remaining active.
- `node --check index.js`, `node --check sandbox.mjs`, `node --check config.mjs`:
  all exit 0.
- `python3 -m py_compile test/probe_opencode.py test/opencode_integration.py`:
  exit 0.
- Configuration preview generated from the actual global config: original
  agent set, prompts, plugin order and unrelated settings preserved. The preview
  does not set `shell`; it hard-denies native agent shell via policy.

The model endpoint in these tests is a local deterministic HTTP server. No
external model quota is used. No auth files are copied into the test state.
The existing-plugin compatibility test reuses the current package cache.

## Independent code review

A fresh reviewer read the implementation. No Critical findings were reported.
Both Important findings received regression tests that failed before the fix
and passed afterward, followed by the full green suites:

1. Escape commands accepted but ignored `workdir`. They now resolve it before
   permission evaluation and use the same cwd for approval metadata and execution.
2. Native edit approval rules omitted `.agents` and `.claude` definitions.
   Both patterns are now included before global denials.

Additional real regression checks found and addressed transient placeholders
appearing in Git status and access to Unix sockets at unusual paths. The socket
filter is architecture-checked and denies io_uring and alternate ABIs to prevent
alternate socket creation paths. This filter was added after the independent
review; it was verified with real socket/Node/npm tests, not a second review.

## Boundaries retained

- This does not OS-sandbox native file tools, MCP/LSP, trusted plugins or user
  TUI/API shell actions. It replaces the agent's terminal tool only.
- Linux x86-64 only; alternate ABIs are denied. Socket creation and io_uring
  restrictions can require approved escapes for some build/test tools.
- `test-engineer` intentionally retains approval-gated escape access.
- Unexpected host/plugin death can leave an exclusive lock and unchanged
  placeholders; those cause denial or require inspected manual cleanup.
- Readable files outside the known mask list may contain secrets. The shell
  can read project `.env` files, as explicitly chosen in the original design.
- New plugins require deliberate updates to the global integration policy.

The old missing-wrapper probe intentionally retains its failing assertion.
It is evidence that the original architecture is unsafe on this binary, not a
failure in the replacement implementation's test suite.
