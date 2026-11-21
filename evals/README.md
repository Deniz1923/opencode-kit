# Coding evaluations

Six tiny projects test actual coding outcomes rather than simulated tool calls.
No dependencies, downloads, or model requests are made by this runner. It needs
Node.js 22+ and Git. Use a fresh workspace and session for each model/case.

```sh
node evals/run.mjs prepare bug /tmp/my-model-bug
```

Open OpenCode in that workspace, select the model and Build agent you want to
measure, and paste the printed task. Keep normal permissions and record approvals.
Only that step uses model quota. Do not show the evaluator source to the agent.
After the agent finishes, check from the kit checkout:

```sh
node evals/run.mjs check bug /tmp/my-model-bug
```

`prepare` refuses to overwrite existing directories. Workspaces stay available
for inspecting the diff. Checks execute the generated code: treat them like
running tests on a patch, and use a disposable environment for untrusted models.
The multistep check temporarily changes and restores its fixture settings file.

For tasks that delegate, run in the TUI or monitor the same disposable parent
session through completion. On OpenCode 2.3.0, `opencode run` can return at the
first idle turn while the child is still running. The service resumes the
parent after the child reports. Grade the final result after that handoff.
If the resumed run is interrupted, continue the same parent in the TUI
with the report it already received.

| Case | What it tests |
| --- | --- |
| `bug` | Existing failing test, boundary cases, negative inputs |
| `api` | API change plus callers and existing tests |
| `build` | Diagnose a real failed command, preserve a public export |
| `multistep` | Finish library, CLI, and configurable behavior |
| `review` | Find two seeded bugs with reproducible evidence; preserve source |
| `resume` | Preserve requirements through compaction and a follow-up change |

For `resume`, finish the initial task, then run:

```sh
node evals/run.mjs check resume /tmp/my-model-resume --stage1
```

Run `/compact` in the same synthetic session. Record whether compaction actually
occurred; otherwise the run does not measure compaction recovery. Paste the task
printed by `node evals/run.mjs followup resume /tmp/my-model-resume`, then run the
normal final check. Do not substitute one of your personal chats.

Record this table for each run; `/usage-live` supplies observed usage where
available. Unknown usage stays unknown. Include failed runs and retries.

| Date | Model/provider + effort | Case | Check pass/fail | Wall time | Input/output/cache tokens | Unneeded approvals | Premature stops | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

A passing check is necessary, not sufficient. Inspect whether tests were weakened,
task scope was respected, the claimed verification ran, and the review explained
the causes. These small public tasks are a smoke benchmark, not evidence of broad
model superiority. Compare the same prompts, initial files, agent settings and
effort; repeat runs before judging a model or prompt change. Do not tune a prompt
solely to these six examples.
