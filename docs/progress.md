# Execution ledger — OpenCode sandbox

Source plan: /home/deniz/.config/opencode/docs/superpowers/plans/2026-10-25-opencode-sandbox.md
Spec: /home/deniz/.config/opencode/docs/superpowers/specs/2026-10-24-opencode-sandbox-design.md

## Decisions

- Ruling: Execute inline in a new repository on branch `implementation`, outside live OpenCode config/plugin directories. No existing repository/worktree exists to preserve. No global configuration changes during development.
- Ruling: Move the OpenCode compatibility probe before the implementation tasks. Test the installed binary through its API, avoiding model quotas and nondeterministic tool selection.
- Preflight: wrapper and plugin share session context; test their real integration before rollout. Migration must preserve unrelated settings. Failure must stop execution, never select another shell.

## Tasks

- [x] Compatibility probe completed: custom shell honored after initialization; **missing shell falls back to Bash and executes the command**. Original safety gate FAILS. See `compatibility.md`.
- [x] Direct bwrap runner, trusted context, filesystem/network isolation, real integration tests. No wrapper is needed in the approved revised design.
- [x] Plugin: session context, escape permission enforcement, output/timeout handling.
- [x] Configuration migration and isolated OpenCode integration.
- [x] Independent review and verified report with an installable configuration preview.

No task is marked complete until its commands ran and the results were inspected.

## Observed blocker

- 2026-10-25: `python3 test/probe_opencode.py` against the installed binary: isolated config PASS; custom shell invoked and exits 77 PASS; missing-wrapper fail-closed assertion FAIL (actual Bash, exit 0, marker created). Global config unchanged. Architecture decision requested before dependent implementation.
- Ruling: Do not implement or install an integration whose fail-closed premise has been disproved. Keep the failing safety check and provide the exact evidence. Cost: changing tool architecture or requiring an OpenCode core fix before rollout.
- Deniz approved the plugin-owned `sandbox_shell` alternative. `docs/revised-design.md` supersedes the original wrapper architecture. No wrapper or session-context files are needed. Built-in agent shell is hard-denied even without the plugin.
- Sandbox runner RED: missing module. GREEN: eight real OS/process tests passed outside the outer Codex sandbox. Verified external and symlink writes, config/Git protections, secret environment removal, credentials, Unix sockets, loopback, missing bwrap, read-only/home guards, output cap and child timeout.
- Plugin and migration RED: missing modules; GREEN: actual permission/cwd effects and migration preservation/idempotence tests passed.
- Final independent review: two Important findings, no Critical findings. Both fixed with regression tests RED→GREEN: requested escape cwd and native edit asks for `.agents`/`.claude`. Full suites green afterward.
- Final: fixed transient placeholder visibility in Git with a sandbox-local excludes file preserving the configured excludes contents; real clean Git status test RED→GREEN.
- Ruling: close the original unusual-socket residual with an architecture-checked seccomp filter rather than just documenting it. Cost: Linux x86-64 only; tools needing Unix socket creation, ptrace, io_uring or alternate ABIs may require an approved escape. Native socket and actual Node/npm tests RED→GREEN.
- Ruling: user-initiated terminals/APIs and native read/edit/MCP/LSP remain host-side, as explicitly outside this agent-tool boundary. Cost: the integration is not whole-agent OS isolation; those integrations must remain trusted and permission-controlled.
- Ruling: preserve the new standalone repository on branch `implementation`; it has no base branch or upstream to merge/push. No publication or PR is authorized. Cost: global activation remains a separate, reviewable rollout.
- Verified: `npm test` → 22/22; `python3 test/opencode_integration.py` → 11/11; JS syntax and Python compilation pass. See `verification.md` for scope and limitations.
- Preview: `.artifacts/opencode.preview.json`, generated from the real config without modifying it. Agent names, original prompts and plugin order verified preserved. Live config SHA256 at preparation: `d847d32b3f5f867010a9b83c392e9b17d521bb8323d9a409df799711d0c8b9bc`.
