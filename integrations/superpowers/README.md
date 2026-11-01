# Workflow producer adapter

This wrapper delegates skill registration and normal hooks to an unchanged
snapshot of Superpowers 7.0.1, revision
`2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`. The upstream entry point, skill-relative
resources, MIT license and provenance are under `upstream/`. The snapshot is the
same revision that was active on the host before this adapter was installed.

Only the `context` callback is gated: for `chat` or a namespaced `/chat` role,
resolved denials for both `skill` and `subagent` skip that callback. Other roles
and other hooks delegate unchanged, except for the Build opt-in below. Explicitly restoring either permission also
restores the upstream callback. Stored transcript APIs are never used by the
wrapper. User quotations and opaque checkpoints require no text matching.

For `build` or a namespaced `/build` role, a standalone system-prompt line
`Use a workflow proportional to the task.` opts out of the automatic bootstrap.
Deniz's Build prompt uses this line and supplies task-sized planning and
evidence-based repetition rules itself. Skills remain registered and callable,
including explicitly requested formal workflows. Other authors' Build prompts
retain upstream behavior unless they deliberately include that opt-in line.
Plan keeps its upstream bootstrap. This changes workflow guidance, never tool
permissions, reasoning effort, model choice, or approval requirements.

The installer copies the adapter into the protected versioned store and replaces
the configured Superpowers loader entry with that managed path. No cached
package is patched. Removing the sandbox component restores the previous loader
entry. Upstream snapshot updates require deliberate review and regression tests.
