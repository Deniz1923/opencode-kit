# Plugin-owned sandbox tools

Approved by Deniz on 2026-10-25 after the installed-binary compatibility probe.

The original wrapper plan is superseded because OpenCode 2.1.3 falls back to a
host shell when the configured wrapper is missing.

1. Permanently deny the built-in agent `shell` action using a global hard policy.
2. Register `sandbox_shell` and `shell_unsandboxed` in a local V2 plugin.
3. `sandbox_shell` gets its writable root from the session directory retrieved
   through the host API. A requested workdir must resolve inside that root.
4. Execute bwrap directly with an argv array. No shell wrapper, prefix detection,
   persisted context file, login shell, or fallback is involved.
5. The root filesystem is read-only. Only the workspace and per-workspace scratch
   persistently permit writes. `/tmp`, `/run`, and `/dev/shm` are private tmpfs.
6. Home/system roots are not writable workspaces. Plugin/config directories stay
   read-only even when they overlap a chosen workspace. Credential paths are
   masked; the bwrap process itself receives an environment allowlist.
7. Protect the workspace's reserved config/extension paths, even when absent,
   with transient mountpoint placeholders. Serialize commands per workspace and
   use an exclusive host-side lock. Clean only the placeholders this run created,
   checking their inode and content. If killed abruptly, safe placeholders may
   remain; never delete existing user files automatically.
8. Freeze plugin loading to the existing trusted global plugins and this plugin
   using global integration policies. New plugin installation requires deliberate
   user configuration. Preserve existing plugin entries and agent prompts.
9. The escape executor asserts `shell_unsandboxed` permission before spawning.
   Force permissive evaluations to ask; preserve denials. Plan/explore/review/debug
   agents cannot escape; test-engineer may request approval as in the original
   design. Run all these agents' sandboxed commands with a read-only workspace.
10. No `shell` config override is installed. User terminal/API shell calls remain
    host-side user actions, outside these agent tools. MCP, LSP and other host
    facilities remain outside the OS sandbox as in the original scope.

## Execution order

- Compatibility evidence (done; original fail-closed premise disproved).
- Real bwrap runner and tests of writes, credentials, sockets/network, Git,
  environment, missing bwrap, output bounds, timeout and protected config paths.
- Plugin tools and permission-before-execution tests.
- Non-mutating configuration generator; preserve unrelated settings and prompts.
- Quota-free integration using a local scripted model endpoint and actual
  OpenCode sessions; exercise plugin absence, policy denials and escape rejection.
- One independent review, relevant fixes and fresh verification.
- Present the generated config and test evidence before global installation.

This is an experimental agent shell sandbox, not isolation of OpenCode itself.

## Review fixes and implementation details

- Escape commands resolve their requested workdir before permission evaluation;
  the same canonical cwd is included in the prompt metadata and used to spawn.
- Native edits to `.agents` and `.claude` definitions require approval.
- Temporary protection placeholders are hidden from Git status with a sandbox-
  local excludes file that preserves the existing excludes file's contents.
- A small native-x86-64 seccomp filter denies `socket(AF_UNIX)`, alternate ABIs,
  ptrace and io_uring. Unlike masking runtime directories alone, this also blocks
  host sockets in HOME or a project. Private `socketpair` IPC still works.
  Unsupported architectures or filter setup failure stop execution.
