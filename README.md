# OpenCode workspace sandbox

Experimental Linux x86-64 agent shell integration for OpenCode 2.1.3 and
bubblewrap 0.13.1. Node.js 26 runs the tests; the plugin uses Node-compatible
built-in modules and has no package dependencies.

## Behavior

- `sandbox_shell` runs terminal commands through bubblewrap. The trusted session
  workspace and private per-workspace scratch are writable. Other host paths are
  read-only; Git metadata and reserved workspace-root configuration paths are
  protected. Read-only agents also receive a read-only workspace.
- Network namespaces isolate the host network. `/tmp`, `/run`, and `/dev/shm`
  are private. A native-x86-64 seccomp filter additionally denies Unix socket
  creation, alternate syscall ABIs, ptrace and io_uring. This prevents reaching
  host Unix sockets at unusual paths as well as standard runtime paths.
  `socketpair` remains available for private IPC. Software requiring Unix socket
  creation, localhost, GPU devices or io_uring may need approved host execution.
- A default-deny environment allowlist and known credential-path masks reduce
  credential exposure. This is not a guarantee that all readable files are free
  of secrets. Project `.env` files remain available to shell commands for tests.
- `shell_unsandboxed` asks before every command, including the effective working
  directory in the permission metadata. Rejections propagate without execution.
  `plan`, `explore`, `code-reviewer`, and `debugger` cannot escape. `test-engineer`
  may request approval for tests that require host access.
- The native agent `shell` action is denied by a global hard policy. If the
  plugin is missing or fails, its tools disappear and native shell stays denied.
- Global integration policy permits only your existing plugin targets and this
  plugin. Installing another plugin requires an explicit config/policy update.

There is no configured shell wrapper. OpenCode 2.1.3 falls back to a host shell
if a configured wrapper is missing; the reproducible probe and source reference
are in [docs/compatibility.md](docs/compatibility.md).

## Scope

The OS boundary applies to `sandbox_shell`. OpenCode itself, native file tools,
MCP/LSP servers, existing trusted plugins and user-initiated TUI/API terminal
actions run host-side. Their behavior is governed by OpenCode permissions and
the trust placed in those integrations. This is not a sandbox around the entire
agent process. Review new project configurations before loading them.

Scratch persists at `/tmp/opencode/sandbox/<workspace-hash>`. Only that project's
scratch is bound into each sandbox. Files there can be accessed by other host
processes running as your user. Keep secrets out of scratch.

Reserved root paths (`opencode.json`, `opencode.jsonc`, `.mcp.json`, `.opencode`,
`.agents`, `.claude`, `.git`) need mountpoints even when absent. The runner creates
temporary placeholders, protects them read-only, then removes only unchanged
placeholders it created. A per-workspace lock serializes this operation. Git
status uses a temporary excludes file inside the sandbox, preserving the user's
existing excludes file and hiding the synthetic entries.

An abruptly killed host/plugin process can leave placeholders or a `.lock`
file. The runner fails closed on an existing lock. Check that no command is
still running before manually removing a stale lock. Do not delete an existing
config or non-empty directory as cleanup. Normal command timeout/cancellation
kills the process group and performs cleanup automatically.

## Stage a configuration

Keep this repository at a stable path outside the workspaces it will sandbox.
No files from this repository should be copied into OpenCode's auto-discovered
plugin directory during staging.

```sh
node config.mjs --input ~/.config/opencode/opencode.json \
  --output /tmp/opencode-sandbox.preview.json
```

Review the generated file before applying it. The generator preserves unrelated
settings, plugin entries and prompts, converts legacy permission/agent shapes,
and adds the sandbox integration and policies. It refuses to overwrite its
input. Running it twice does not duplicate rules or plugin entries.

Applying the preview to the global configuration and restarting OpenCode are
separate rollout steps. Back up the existing config first. To roll back, restore
that backup and restart OpenCode. This repository is private/unpublished; no
upstream PR or npm publication has been made.

## Verify

Run outside an outer sandbox that prohibits namespaces or localhost servers:

```sh
npm test
npm run test:opencode
```

The first command covers real bwrap containment, working-directory boundaries,
Git and config protection, credentials/environment, sockets, output limits,
timeout children, plugin permission order, and config migration.

The second starts private OpenCode servers and a scripted model listening only
on localhost. It uses no external model, token quota or copied auth files. It
checks real tool calls, approval/rejection, explicit denies, absent/failed
plugins, global policy precedence, project plugin blocking, session moves and
compatibility with the plugin entries in the current user's global config.
Test config/state are isolated; the compatibility case reuses the user's
existing package cache. Observations go in git-ignored `.artifacts/`.

`python3 test/probe_opencode.py` is a separate diagnostic of the **superseded**
wrapper architecture. Its missing-wrapper safety assertion intentionally fails
on OpenCode 2.1.3. It is not part of the plugin-owned implementation's test suite.
