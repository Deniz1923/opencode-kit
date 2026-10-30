# Deniz's setup

This is a reproducible description of the current setup, not a copy of the live
home directory. Authentication, provider secrets, sessions, private backups and
machine-specific managed paths are not stored here. Agent prompts are preserved
as installed. Chat's unused workflow tools and injected reminders are disabled
as described in the README; its answer style, model and practical tools are kept.

## Components

- The sandbox implementation and generated permission policies live in this repo.
- `packs/deniz-agents/` contains Build, Chat, Plan, Explore, Code Reviewer,
  Debugger and Test Engineer prompts, descriptions and access declarations.
- Optional workflow preferences enable todos and control delegation depth.
- `examples/deniz-preferences.jsonc` records manual sharing, todo enabled,
  delegation depth 2, and the two optional executable plugins used locally:
  `@prevalentware/opencode-goal-plugin` and Superpowers.

No model or provider credential is pinned/exported. Select and authenticate your
own provider/model in OpenCode. The sandbox does not require the optional plugins.
They retain host authority; install them only if you want that workflow.

## Fresh installation

Install the supported OpenCode/bwrap/Node/Git versions listed in the README,
authenticate GitHub, and obtain access to this private repository. Then:

```sh
gh repo clone Deniz1923/opencode-kit
cd opencode-kit
npm ci --ignore-scripts
node cli.mjs init
```

Choose the components in the menu. For sandbox + Deniz agents + workflow:

```sh
node cli.mjs init --sandbox --agents deniz --workflow
```

The menu previews and asks before applying. On an existing config it asks about
conflicts. The kit's optional workflow default is delegation depth 1; Deniz kept
the existing value 2 during the live upgrade. If you want the same preferences,
review/merge the example before setup and choose **Keep current** for that
conflict. Do not create a second config file beside an existing `.json`/`.jsonc`.

Local primary roles are named `build`, `chat` and `plan`; a new agent-pack install
uses `deniz/build`, `deniz/chat`, `deniz/plan`, etc., so packs can coexist. The
Deniz pack selects `deniz/build` as its default unless a conflict is kept.

To use the sandbox with someone else's agents, select sandbox only and add their
pack instead:

```sh
node cli.mjs add agents ./another-pack
node cli.mjs add agents github:AUTHOR/REPOSITORY#TAG
```

## Active access profiles

| Role | Project access | Host escape |
| --- | --- | --- |
| Build / General / Chat | Workspace write | Always asks |
| Plan | Specs/plans folders plus scratch | Denied |
| Explore / Reviewer / Debugger | Read-only; scratch allowed | Denied |
| Test Engineer | Read-only; scratch allowed | Always asks |

Plan's default folders are `docs/superpowers/specs` and `docs/superpowers/plans`.
Git metadata, credentials and agent/config/plugin definitions are protected.
The installer creates the trusted policy and versioned paths for the invoking
user. Do not copy Deniz's generated absolute paths to another machine.

Run `node cli.mjs doctor` after applying. Full local-model checks are available
with `node cli.mjs doctor --full` and require Python 3; they use no model quota.
The installed shell boundary excludes host-side integrations as described in
the README.
