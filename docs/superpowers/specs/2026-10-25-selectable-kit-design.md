# Selectable OpenCode kit

Status: proposed design for approval. Existing sandbox installation stays active.

## Intent

A friend installs OpenCode, runs one setup command, and chooses the parts they
want: Deniz's sandbox, Deniz's agents, agents from another author, and optional
workflow/settings presets. Combining components must preserve existing choices
and must not silently grant an imported agent more authority.

## Decisions from Deniz

- Support Linux x86-64 for the installer and sandbox. No macOS/Windows port.
- Agent prompts remain ordinary text; no platform-specific prompt conversion.
- Plan can write designated planning documents and temporary files. Application
  source stays read-only to Plan.
- Preserve existing settings. On a conflict, show the differences and offer
  keep, replace, or rename where meaningful. No silent last-pack-wins behavior.
- Components are selectable. Installing the sandbox does not require Deniz's
  agent prompts, goal plugin, or Superpowers workflow.

## Approaches

1. Plain configuration files with manual copy steps: useful as an export, but
   does not meet the requested selectable setup and conflict handling.
2. One GitHub repository with a small setup CLI and independent components:
   recommended. Reuse native OpenCode plugin/agent formats and the existing
   sandbox implementation. This matches the requested command-based workflow.
3. A central marketplace/registry or OpenCode fork: unnecessary for this release.
   GitHub sources and local directories are sufficient for agent packs.

## Components and ownership

- **Sandbox module:** current execution plugin plus its mandatory permissions,
  hard policies and trusted agent access profiles. These install together.
- **Agent pack:** names, descriptions, prompt text, optional model preferences,
  restrictive permissions and declared access requirements. Supports native
  agent Markdown/JSON files; a small optional manifest describes a bundle.
- **Workflow/settings preset:** optional skills, review/planning instructions,
  todo setting and delegation preferences. No provider credentials are exported.
  If a selected agent pack expects `todowrite`, show and resolve its dependency
  on `experimental.todo`; do not leave a prompt requesting an unavailable tool.
- **User preferences:** remain local and override ordinary pack defaults after
  resolving conflicts. They cannot silently disable the selected sandbox's
  mandatory safeguards while reporting the sandbox as enabled.

Keep the current plugin entrypoint at the repository root for compatibility.
Add the CLI and installer libraries alongside it; do not move the live plugin
into a new directory as an incidental packaging change. Distribute one package
initially, with components logically independent. No separate registry service.

## Setup experience

Proposed public command names are illustrative until a name is selected and a
release is published:

```text
opencode-kit init
opencode-kit add agents github:author/repository#tag
opencode-kit list
opencode-kit update
opencode-kit remove <component>
opencode-kit doctor
```

`init` opens an option-based terminal setup. It selects components, compatible
access profiles and any ordinary preferences, then shows a concrete preview.
Noninteractive flags support the same selections. Existing configurations must
not be overwritten merely because stdin is noninteractive: unresolved conflicts
stop with an explanation. A fresh installation with no config is supported.

For each conflict: show its source and current/proposed values. Offer keep and
replace, plus rename for agents or other named items. Changing an agent ID must
also update the kit-owned references and capability mapping, with a preview.
Security conflicts cannot retain an unsafe value while claiming sandbox safety;
the user can accept required changes, omit the sandbox, or cancel setup.

After the preview, obtain approval to apply and restart OpenCode. Back up the
affected files, apply using staged files and a recovery journal, then run checks.
Failure restores the previous configuration and reports the exact failed step.

## Agent compatibility and access profiles

Replace the runtime's hardcoded read-only/escape agent-name lists with a trusted
per-agent mapping generated from the user's selected components and choices.
Store this mapping outside projects under the kit's user configuration directory.
Project-controlled plugin options must not be able to grant extra authority.

Profiles describe behavior, rather than recognizing a particular author's name:

| Profile | Project writes | Persistent scratch | Host escape |
| --- | --- | --- | --- |
| Reader/reviewer | None | Allowed | Denied by default |
| Planner | Selected planning roots only | Allowed | Denied by default |
| Writer/builder | Workspace except protected paths | Allowed | Ask when enabled |

Explicit imported denials remain restrictive. An imported `shell: deny` must not
quietly become permission to use the replacement `sandbox_shell`. Unknown agents
default conservatively; importing a pack must not grant an unreviewed escape.
Preserve the current users' intended Build/General/Chat and test-engineer access
through explicit profile entries and a visible migration preview.

Enforce the selected profile in both the OS sandbox and native edit permission
evaluation. Explicit configured denials remain final. Native file tools remain
host-side: this is application permission enforcement, not whole-agent OS
isolation. Keep the native agent shell hard-denied even if the plugin fails.

Planner output roots are configurable. Proposed defaults match the existing
workflow: `docs/superpowers/specs/` and `docs/superpowers/plans/`, plus scratch.
Validate them against the trusted workspace; reject traversal, symlink escapes,
protected paths and overly broad roots. Do not create directories on the host
through untrusted path strings. Confined preparation and verified/pinned mount
sources must preserve the boundary when a configured directory is absent or
another command is changing its parents. Default workspace/source access remains
read-only, with only the approved planning roots made writable.

## Installer state and data handling

- Derive paths from the current user's Linux/XDG environment; never export
  machine-specific home paths or private auth/session data as someone else's defaults.
- Use a stable, versioned managed store for plugin code and pack contents.
  Keep records of source commits/versions, hashes and ownership of generated
  files/rules. Protect this store and the trusted profile file from agent edits.
- Parse JSON/JSONC and agent frontmatter as data, preserving unrelated settings
  and comments. Reuse established parsers rather than ad hoc comment stripping.
- Resolve GitHub agent sources to recorded commits. Import only declared/native
  agent data, not JavaScript plugins, shell hooks or package lifecycle scripts.
  Validate names and canonical source paths; reject traversal and unsafe links.
- Preserve existing plugin choices and generate the required allowlist changes
  when the user deliberately selects another executable plugin. Treat executable
  plugins separately from plain agent packs.
- Update/remove only kit-owned entries. Detect user edits since installation and
  ask on conflicts. Repeated setup is idempotent; mixed packs do not duplicate
  rules or silently delete each other's settings.

## Checks and scope

Retain the existing tests and add targeted coverage for the actual audit gaps:
Plan writing designated outputs through either tool route while source edits
fail; imported or renamed read-only agents staying restricted; explicit shell
denials carrying over; and project config being unable to grant extra access.

Test fresh setup, existing JSONC, collisions, repeated installation, update,
removal, rollback and interrupted installation with disposable homes/configs.
`doctor` checks declared platform/dependencies, selected components, live hard
policies and agent profiles. Real execution checks use a local scripted model;
no external model quota or copied credentials. Reuse the existing strategy.

Only advertise OpenCode/bwrap/runtime versions actually tested. Reject unsupported
sandbox setups rather than silently falling back. Agents/settings can be selected
without the sandbox, with the resulting security state shown clearly.

Publishing needs a clean release, license, README, version compatibility statement
and installation/removal instructions. Proposed license: MIT, pending approval.
The GitHub destination and npm name can be chosen when the release is ready.
Creating a public repository or publishing a package requires separate approval.

## Left to the builder

Exact CLI library/file layout, parser versions, state schema and efficient test
organization are routine implementation choices. Keep the first release small.
Do not add a marketplace, cross-platform sandbox backend or additional review
loops. Run one builder check on this design and one final implementation review.

## Builder check

One fresh reviewer checked for unanswered questions that would block planning.
Result: "nothing important left". No additional scope or review round was added.
