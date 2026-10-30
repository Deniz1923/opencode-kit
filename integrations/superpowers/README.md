# Restricted-Chat producer adapter

This wrapper delegates skill registration and normal hooks to an unchanged
snapshot of Superpowers 7.0.1, revision
`2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`. The upstream entry point, skill-relative
resources, MIT license and provenance are under `upstream/`. The snapshot is the
same revision that was active on the host before this adapter was installed.

Only the `context` callback is gated: for `chat` or a namespaced `/chat` role,
resolved denials for both `skill` and `subagent` skip that callback. Other roles
and other hooks delegate unchanged. Explicitly restoring either permission also
restores the upstream callback. Stored transcript APIs are never used by the
wrapper. User quotations and opaque checkpoints require no text matching.

The installer copies the adapter into the protected versioned store and replaces
the configured Superpowers loader entry with that managed path. No cached
package is patched. Removing the sandbox component restores the previous loader
entry. Upstream snapshot updates require deliberate review and regression tests.
