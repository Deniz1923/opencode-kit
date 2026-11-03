# Sandbox audit fixes — 2026-11-03

Validated on OpenCode 2.2.4, bubblewrap 0.13.1, Linux x86-64.

## Changes

- Native file checks resolve symlink components even when their destination is
  missing. A dangling alias cannot turn a workspace write into an outside write,
  or a Plan document into an application-source write.
- Native reads check canonical absolute permissions as well as OpenCode's
  normalized internal resources. Reads and searches into known private paths
  are denied; broad searches that would include those paths require narrowing.
- Shell masking and native guards share an inventory of credential, config,
  application-history and private kit paths. Default and resolved XDG/OpenCode
  locations are covered, including relocated GitHub CLI and gcloud credentials.
- Existing nested Git/config/plugin paths are mounted read-only. Missing config
  siblings beside existing configuration, and in the command's current directory,
  receive protected temporary placeholders. Cleanup preserves changed files.
- MCP servers are hard-denied by the sandbox component's global policy, including
  when the runtime plugin is absent. Project configuration cannot lift the deny.
- Non-stream Unix socketpairs are denied. Private stream IPC remains available;
  ordinary Node/npm tests still run.
- Migration retains stricter existing global permissions, including scoped
  command denials. Escape evaluation still preserves explicit denials.
- Ordinary shell input no longer advertises an approval-reason field. Likely
  sandbox restriction failures explain the actual approval route, without
  executing a retry or granting permission.
- Build prefers native web tools for research, requests needed terminal access,
  and uses exact workspace approval for ordinary additional-directory files.
  Once approved, directory-boundary checks do not repeatedly prompt; agent
  profiles and file restrictions remain authoritative.

## Verification

`npm test`: **97 passed, 0 failed**, including packaged installation, doctor, and
**31 disposable OpenCode integration tests** backed by a local scripted model.
Regression cases cover real bwrap execution and native tool behavior, not only
permission-event mocks. The independent review's XDG-mask finding was reproduced
with synthetic credentials and fixed. Installed-setup doctor passed.

Fresh Nemotron 3 Ultra Free sessions tested real model choices:

- A natural terminal HTTP task first failed inside the sandbox, requested exact
  host-command approval, and returned HTTP 200 after approval.
- Rejecting the same request prevented host execution. OpenCode ended the turn
  with a permission-rejection error rather than producing another model answer.
- Current upstream research requested websearch and webfetch approvals.
- An initial additional-directory trial chose too broad a host-shell route;
  that request was rejected. After refining guidance, a fresh trial requested
  exact workspace approval and wrote the requested file with native tools, with
  no repeated external-directory prompt and no host-shell escape request.

Only fresh synthetic sessions, fake private data, and disposable projects were
used. Existing user conversations and credential-file contents were not read.
Test sessions and fixtures were removed after verification. Live installation
used automatic backups and preserved other agents, model settings and delegation
depth; a repeat installation preview reported no changes or conflicts.

## Remaining scope limits

This remains a shell sandbox with application guards for native tools, not OS
confinement of the whole host application. Native path validation is not an
atomic filesystem transaction against concurrent same-user host changes.
Mounts cannot reserve filenames in directories created after a command starts;
the plugin allowlist and MCP denial provide separate integration restrictions.
LSP/formatter execution, trusted host plugins and arbitrary project-configuration
consumers remain outside this boundary. Do not treat arbitrary newly generated
project configuration as trusted host code. Unknown secret files, pre-existing
hardlink aliases, kernel vulnerabilities, approved host commands and other
same-user host processes remain outside the stated guarantees.
