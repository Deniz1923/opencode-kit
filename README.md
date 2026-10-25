# OpenCode kit

Choose a Linux sandbox, Deniz's agents, another author's agents, or a combination.
Existing settings stay in place. Conflicts offer **keep, replace, or rename**;
noninteractive installation stops when a choice is missing.

Local release candidate: no public GitHub/npm release exists yet. The package is
marked private to prevent accidental publication. License: MIT.

## Install

Requirements: **Linux x86-64**, OpenCode **2.1.3**, bubblewrap **0.13.1**, Git,
Node.js 22+. Tested on CachyOS with Node.js **26.12.1**. Other OpenCode/bwrap
versions are rejected until compatibility is tested. Agent prompts are ordinary
text; this installer and OS sandbox target Linux only.

Inside the downloaded/cloned checkout:

```sh
npm ci --ignore-scripts
node cli.mjs init
```

The menu offers sandbox + Deniz agents + workflow, sandbox only, or agents only.
It previews changes, asks before applying/restarting, and makes private backups.
It does not install or rebuild OpenCode. Flags allow independent selections:

```sh
# Preview only. No live configuration changes.
node cli.mjs init --sandbox --dry-run

# --apply authorizes applying the selection, with conflicts still checked.
node cli.mjs init --sandbox --agents deniz --workflow --apply
node cli.mjs add agents ./friends-agent-pack --apply
node cli.mjs add agents github:AUTHOR/REPOSITORY#TAG --apply

node cli.mjs list
node cli.mjs doctor
node cli.mjs update --dry-run
node cli.mjs remove agents:deniz --apply
node cli.mjs remove sandbox --apply
```

Restart OpenCode after applying, or explicitly append `--restart`.
Sandbox-only keeps your prompts. Agents-only does not install a sandbox.
Existing executable plugins are preserved; agent packs cannot install plugins.
Deniz's Build prompt uses todos, so its pack visibly declares the todo dependency.
Keeping an existing disabled todo setting skips the dependent pack.

## Profiles

| Profile | Project writes | Scratch | Host escape |
| --- | --- | --- | --- |
| `read-only` | None | Allowed | Denied by default |
| `planner` | Selected planning folders | Allowed | Denied by default |
| `workspace-write` | Workspace except protected paths | Allowed | Ask if enabled |

Plan defaults to `docs/superpowers/specs/` and `docs/superpowers/plans/`. Both shell
and native edit permission checks apply its limits. Source stays read-only.
Unknown agents default conservatively; explicit imported terminal/escape denials
remain restrictive. Project plugin options cannot change trusted capabilities.

```sh
node cli.mjs init --sandbox --agents ./team \
  --profile team/architect=planner \
  --planning-root docs/designs --planning-root docs/plans --apply
node cli.mjs init --sandbox --profile team/builder=workspace-write \
  --escape team/builder=ask --apply
```

Review the printed profiles. Host escape always requires approval. Defaults are
writer for Build/General/Chat, planner for Plan, reader for review/exploration.
The test engineer may request an approved host escape.

## Make an agent pack

Place native Markdown agents under `agents/` (or `.opencode/agents/`):

```markdown
---
description: Reviews code without modifying project files
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Inspect changes and report concrete bugs with file references.
```

JSON/JSONC definitions also work. An optional `opencode-kit.json` declares metadata:

```json
{
  "formatVersion": 1,
  "name": "My team",
  "namespace": "team",
  "version": "1.0.0",
  "agents": [
    {"file": "agents/reviewer.md", "access": {"profile": "read-only"}},
    {"file": "agents/planner.md", "access": {"profile": "planner"}}
  ]
}
```

IDs become `team/reviewer`, etc. Structured default-agent references and profiles
follow renames. Names inside prompt prose remain literal text. GitHub sources
resolve to a recorded commit. Hooks, plugins, executable fields, config
interpolation, symlinked files, scripts and submodules are not imported. Prompts
are still untrusted instructions; review them before use.

Automation can pass `--resolve choices.json`, using IDs printed by the preview:

```json
{
  "[\"default_agent\"]": {"action":"keep"},
  "[\"agents\",\"team/reviewer\"]": {"action":"rename","name":"team/reviewer-v2"}
}
```

## Storage and recovery

Paths follow `$HOME`, XDG settings, and `OPENCODE_CONFIG_DIR`:

- OpenCode config: `~/.config/opencode/opencode.json` or existing `.jsonc`.
- Trusted policy and backups: `~/.config/opencode-kit/`.
- Ownership state: `~/.local/share/opencode-kit/state.json`.
- Versioned code: `~/.local/share/opencode-kit/versions/<content-hash>/`.
- Private project scratch: `/tmp/opencode/sandbox/<workspace-hash>/`.

Updating a checkout does not silently alter managed live code. Removal restores
owned changes while preserving unrelated settings/comments. Changed owned
entries require a choice. Stale previews and modified code are rejected. Backups
can contain existing provider settings: keep them private; never publish them.

After interruption, stop other setup processes, then run `node cli.mjs recover`.
Recovery restores previous files and refuses to overwrite later user edits.
Old unreferenced code/backups remain for inspection; no recursive user-data
cleanup occurs. Sandbox failures and stale workspace locks fail closed. See
[compatibility notes](docs/compatibility.md) for the rejected wrapper architecture.

## Security scope

The plugin-owned `sandbox_shell` runs commands inside bwrap. The built-in agent
`shell` is hard-denied. Missing/failed plugins leave it blocked. OpenCode 2.1.3
falls back to Bash for a missing configured shell wrapper, so wrappers are not
used as a boundary.

The OS sandbox blocks network and host Unix sockets, uses minimal devices,
makes the host read-only, protects Git/config/plugin paths, masks common
credentials and allows only selected environment variables. Workspace-write can
delete ordinary project files. Planner gets only its output folders plus scratch.
Missing bwrap fails closed. Kernel/bwrap vulnerabilities remain possible.

OpenCode itself, native file tools, executable plugins, MCP/LSP servers, web
tools, and user terminals are outside this shell OS boundary. Native edits use
application permission checks. Existing plugins retain host authority. Web tools
ask by policy. Project `.env` is readable to shell tests; native `.env` reads are
denied. This is not a whole-agent sandbox or complete secret vault. Approved
escapes run with your full user authority. Host processes under your user can
access scratch; keep secrets out of it.

`doctor` checks versions, profiles, managed safeguards and real bwrap execution.
`doctor --full` also runs private OpenCode servers with a local scripted model;
Python 3 is required and no model quota is consumed.

## Test and share a local release

```sh
npm test
npm run test:opencode
npm pack --ignore-scripts
npm install --global ./opencode-workspace-sandbox-0.2.0.tgz --ignore-scripts
opencode-kit init
```

Real namespace/server tests need a compatible host permitting unprivileged bwrap.
CI runs data/installer checks; full host checks remain a release requirement.
The historical `test/probe_opencode.py` wrapper diagnostic intentionally fails
its missing-wrapper assertion on 2.1.3; it is excluded from the passing suite.
Choose the repository and public package name before publication. The package
excludes credentials, live configs, backups, development artifacts and history.
