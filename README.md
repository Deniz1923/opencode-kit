# OpenCode kit

Choose a Linux sandbox, Deniz's agents, another author's agents, or a combination.
Existing settings stay in place. Conflicts offer **keep, replace, or rename**;
noninteractive installation stops when a choice is missing.

Source: [Deniz1923/opencode-kit](https://github.com/Deniz1923/opencode-kit), a private
repository. GitHub access is required to clone it. The npm package is marked
private to prevent accidental registry publication. License: MIT.

## Install

Requirements: **Linux x86-64**, OpenCode **2.1.3, 2.1.4, 2.2.1, 2.2.3 or 2.2.4**, bubblewrap **0.13.1**, Git,
Node.js 22+. Tested on CachyOS with Node.js **26.12.1**. Other OpenCode/bwrap
versions are rejected until compatibility is tested. Agent prompts are ordinary
text; this installer and OS sandbox target Linux only.

Clone using an authenticated GitHub account that has access:

```sh
gh repo clone Deniz1923/opencode-kit
cd opencode-kit
npm ci --ignore-scripts
node cli.mjs init
```

The menu offers sandbox + Deniz agents + workflow, sandbox only, or agents only.
It previews changes, asks before applying/restarting, and makes private backups.
It does not install or rebuild OpenCode. Flags allow independent selections:

[Deniz's setup notes](docs/deniz-setup.md) record the active roles, optional plugins
and non-secret preferences. Live credentials, installation paths, session data,
backups and runtime state are excluded from this repository.

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

Each session records its initial workspace independently of its current location.
Moving a session, including through Code Mode, does not authorize another writable
directory. The agent uses `workspace_approve` to request approval for an exact
additional directory. Rejection grants nothing; approval lasts for that session
across restarts and retains the agent's existing profile. Plan still writes only
its planning folders, and readers remain read-only. Subagents inherit their
parent's approved directories. Commands can select an approved directory through
`workdir`; each invocation is sandboxed within that selected workspace.

Approval records contain only session IDs and directory paths in the private
`~/.config/opencode-kit/workspaces/` directory (following XDG settings). They do
not contain conversation text. Workspace approval does not authorize network
access or unsandboxed execution.

## Chat without coding overhead

The Deniz Chat agent keeps its original conversational prompt and model choice.
It can use web search, read/search/edit files, and run sandboxed commands when
requested. It does not load skills, delegate to subagents, manage autonomous
goals/todos, or use Code Mode's host utilities. Build and Plan keep their tools.
Host escapes retain their existing approval rules.

When Superpowers is configured, the kit installs a managed producer adapter
using the same upstream 7.0.1 revision recorded in its provenance file. It skips
the upstream context-injection callback for restricted Chat agents. Plan keeps
that callback; Deniz's Build uses the proportional workflow described below.
The original skills stay registered.
Goal mode uses OpenCode's built-in `/goal` on 2.2.1 and later; the optional
preferences no longer install a separate goal plugin or its generic reminders.
The adapter does not retrieve stored messages or remove quoted user text.
This is context trimming, not a shorter-answer prompt or a reasoning limit.
The plugin recognizes `chat` and namespaced roles ending in `/chat`. It skips injection
only when both skill and subagent permissions are denied. Denied workflow tools
are explicitly omitted even on hosts that advertise them. Restoring either tool
also restores the workflow context. An agents-only installation disables
those tools but cannot prevent another plugin's injected context.

## Build workflow

Deniz's Build handles clear small changes through inspection, implementation,
and verification. Moderate changes get a short plan; ambiguous, architectural,
or high-risk work gets formal design/planning and appropriate independent review.
It escalates when investigation reveals wider risks. Explicitly requested skill
workflows and required repository instructions still apply.

Repeating a read, plan, test, review, or delegation needs changed evidence, a
failure, or a specific unresolved question. Required checks must still run, and
results invalidated by a change must be checked again. Review findings receive
fixes and relevant verification without automatically restarting the whole
process. Independent work gets focused subagent briefs; tightly coupled changes
are implemented directly by default.

The prompt's standalone line `Use a workflow proportional to the task.` opts
Build out of Superpowers' automatic startup dispatcher while keeping all skills
available. Other authors' Build prompts retain their current behavior unless
they adopt that line. These are behavioral instructions, not a guarantee against
model loops or provider timeouts; there are no new hard limits on reasoning,
reviews, tests, or answer length. Sandbox permissions and approvals are unchanged.

For an existing Chat agent, append these permission rules; keep its system prompt:

```json
[
  { "action": "subagent", "resource": "*", "effect": "deny" },
  { "action": "skill", "resource": "*", "effect": "deny" },
  { "action": "*goal*", "resource": "*", "effect": "deny" },
  { "action": "todo*", "resource": "*", "effect": "deny" },
  { "action": "execute", "resource": "*", "effect": "deny" }
]
```

In a fresh-session local-model measurement with Deniz's two optional plugins,
message and tool-schema JSON fell from 45,634 to 11,165 characters (about 76%).
This measures fixed request overhead, not billed tokens or answer quality.
Long histories and file/web results still consume context. Start a new Chat
session for an unrelated topic; switching an existing coding session to Chat
does not erase its history. Automatic compaction remains at OpenCode's defaults.

## Titles when the provider limits requests

The provider can reject an automatic title request with `429 FreeUsageLimitError`
while still accepting the normal reply. For that specific failure, the plugin
sets an untitled session's title locally from the first meaningful line of the
outgoing title request (up to 12 words/80 characters). This is a simple text
excerpt, not an AI summary. Successful AI titles and existing manual titles keep
their normal behavior; primary responses and errors are not rewritten.

The fallback makes no additional model calls and does not read session history
or scan existing chats. It keeps only bounded candidate titles in memory while
requests are pending, and performs no historical title backfill.

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
Public repository visibility and npm publication remain separate decisions. The
package excludes credentials, live configs, backups, development artifacts and history.
