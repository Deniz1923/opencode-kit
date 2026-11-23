# Project handoff

Start future project work from the `opencode-kit` checkout. The original
`opencode-sandbox` and `opencode-kit-dev` folders were worktrees of the same
repository. The old `implementation` branch ends at `f35339f`, an ancestor
of the kit. Its source remains in Git, and local sandbox test artifacts are under
`.artifacts/legacy-sandbox/`. Earlier design and rollout documents are historical
records. Use the README and this handoff for current behavior.

## Release and installed setup

- [GitHub repository](https://github.com/Deniz1923/opencode-kit) and
  [v0.3.1](https://github.com/Deniz1923/opencode-kit/tree/v0.3.1) are public.
  The released tag was verified from an anonymous clone with a disposable
  Linux x86-64 home, OpenCode 2.3.2, and bubblewrap 0.13.1. The test installed
  agents alone, added the remaining components, and passed doctor.
- Build subagent recovery first shipped on `main` in
  [44192d7](https://github.com/Deniz1923/opencode-kit/commit/44192d7), after the
  v0.3.1 tag. Install from that commit or a newer commit on `main` to get it.
- Deniz's existing installation uses its own `build`, `chat`, `plan`, and
  specialist IDs with the managed sandbox, workflow, Ponytail, optional usage
  dashboard, and Superpowers. Existing delegation depth 2 was preserved. A
  fresh Deniz pack installs agents under the `deniz/` namespace. See
  [Deniz's setup](deniz-setup.md) for access profiles and install options.
- The launcher loads versioned runtime code from the managed store. This source
  checkout can move without changing the installed runtime. Use
  `node cli.mjs update --dry-run` before applying an upgrade. A user-owned
  prompt, such as the live Build prompt, can require a targeted update in
  addition to installing the new plugin.

## Where to work

| Area | Source |
| --- | --- |
| Installer, config merge, conflicts, recovery | `cli.mjs`, `kit/` |
| Native permission policy and agent access | `config.mjs`, `defaults.mjs`, `policy.mjs` |
| Terminal runtime, workspace approval, session hooks | `index.js`, `sandbox.mjs`, `workspaces.mjs` |
| Build, Chat, Plan, and specialists | `packs/deniz-agents/` |
| Superpowers, Ponytail, and usage dashboard | `integrations/` |
| Regression tests and coding evaluations | `test/`, [`evals/`](../evals/README.md) |

The plugin owns `sandbox_shell`. The kit hard-denies OpenCode's native agent
shell so a missing plugin cannot fall back to host Bash. A full host command
requires explicit approval through `shell_unsandboxed`. The OS boundary covers
shell processes. Native file tools, trusted plugins, and user terminals have
separate permissions. See the [README](../README.md) for the full boundary.

## Build subagent recovery

OpenCode 2.3.2 owns child execution, report delivery, and waking the parent.
The kit adds short Build guidance when OpenCode delivers a fresh report.
It uses the message metadata supplied by the session hook. Quoting a report
in an ordinary message does not trigger the handoff guidance.

- While a child runs, work on independent tasks or yield with dependent todos
  open. When a report arrives, continue the original task and verify the result.
  Treat a report that lists running work as an interim update.
- After a launch failure, quota error, cancellation, or an unusable result,
  retain evidence already delivered and finish the missing authorized work
  directly. Keep a cancelled child stopped and respect permission denials.
- If the user explicitly authorizes an exact fallback model for this task,
  Build can try it once in the same child session after a model failure.
  If that retry fails, Build continues directly. There is no automatic
  provider switch or separate retry service.
- Recovery still needs a working parent model and an OpenCode service that can
  deliver the report. A headless invocation can return while a child is still
  running. Inspect the final result after the parent has processed the handoff.

## Verification record

| Check | Observed result |
| --- | --- |
| Recovery commit on OpenCode 2.3.2 | `npm test` passed all 127 tests, including the packaged install and full doctor with 43 OpenCode integration checks. |
| Scripted recovery scenarios | A quota error, an interrupted child, and a successful report arriving after parent idle all ended with the parent verifying the requested output. The authorized fallback test retried once on the alternate model in the same child, then finished directly after the retry failed. |
| Real HY4 Flash Free parent and child | The child finished, the parent used its report, and the expected fixture result was written. One child launch. |
| Real HY4 Flash Free parent and simulated child quota error | The parent received the error and wrote the expected fixture result itself. One child launch and no fallback. |
| Deniz's live rollout | Backed up the managed configuration, updated the existing Build workflow paragraphs and installed the matching runtime. Started the stopped service and verified the loaded Build prompt, plugin, and a passing sandbox doctor. |

The local scripted suite uses no provider quota. The two HY4 runs used fresh
disposable sessions. They measure the handoff behavior only.

## Next harness work

1. Give long sandboxed commands a job handle with status, cancellation, bounded
   output, and access to the full log. Today a shell call waits for the process
   and a second call can hit the same-workspace lock. Keep existing permissions
   and containment when changing the job lifecycle.
2. Use the [six existing coding evaluations](../evals/README.md) to measure the
   same model and effort across harness changes. Record completion, elapsed
   time, uncached input, retries, and approval count. Include compaction and
   delegation failure cases when comparing long-session behavior.

Broad quality and speed parity with Codex or Claude Code remains unmeasured.
