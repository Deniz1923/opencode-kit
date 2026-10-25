# OpenCode 2.1.3 compatibility probe

Date: 2026-10-25

## Result: the saved wrapper architecture cannot be installed as designed

The configured wrapper **is supported once the location configuration has
initialized**, but a missing wrapper does **not** fail closed. OpenCode selects
`/usr/bin/bash`, executes the submitted command, and reports exit 0. A plugin
guard does not fix the combination of a missing wrapper and an absent/failed
plugin.

This was tested against the installed `opencode v2.1.3`, using disposable config,
data, cache, state, project, and marker-file paths. No model or API quota is used.
The global OpenCode configuration was not changed.

The probe initially used a single `opencode api --standalone shell.create`
request. That API can spawn a command before configuration initialization has
completed, so it initially selected the environment's Fish shell. The final
probe uses a persistent private server, checks configuration, creates a session,
and lists plugins before submitting the command. This eliminates startup timing
as an explanation for the missing-wrapper fallback.

## Reproduce

```sh
python3 test/probe_opencode.py
```

The test must be run outside a sandbox that prohibits starting a localhost
server. It binds only to loopback, reads its own temporary server password
without printing it, and terminates the server on exit.

Expected on this OpenCode release: configuration isolation and custom-wrapper
tests pass; the **missing-shell fail-closed assertion fails**. That failed test
is the safety gate, not a test to weaken or bypass.

Machine-readable observations are written to `.artifacts/custom-shell.json`
and `.artifacts/missing-shell.json` before disposable projects are cleaned up.

## Supporting source

OpenCode's version-tagged source confirms the fallback:

- `packages/core/src/shell/select.ts`, `select()` lines 107–114: failure to resolve
  the requested executable selects `fallback()`.
- `fallback()` lines 124–129: Linux chooses Bash, otherwise `/bin/sh`.
- `resolve()` lines 165–174: a configured shell is passed through `select()`.

https://github.com/anomalyco/opencode/blob/v2.1.3/packages/core/src/shell/select.ts

## Decision required before implementation

Recommended: keep the built-in agent `shell` tool denied using configuration
policy and expose a separate plugin-owned `sandbox_shell` tool that executes
bwrap directly. The plugin-owned escape tool remains approval-gated. If the
plugin fails to load, neither plugin tool exists and the built-in agent shell
stays denied. This changes the original tool names and shell-selection design;
it requires the owner's approval and real permission-failure tests.

Alternative: patch OpenCode core so an explicitly configured but missing shell
is an execution error, then build/test that patched version before implementing
the original wrapper architecture. A standalone local shell wrapper cannot
change OpenCode's existing fallback behavior.

Neither alternative is currently implemented or installed.
