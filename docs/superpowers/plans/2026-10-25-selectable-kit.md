# Selectable OpenCode Kit Implementation Plan

> Execute inline with superpowers:executing-plans; user approved the design and asked to proceed. One final independent review.

**Goal:** Fix agent permission composition and provide a selectable Linux installer that preserves existing configuration.
**Architecture:** Keep the plugin entrypoint stable. A trusted global policy file supplies agent capabilities; the CLI composes data packs and managed settings, previews changes, and applies reversible transactions.
**Tech stack:** ESM JavaScript, Node built-ins, jsonc-parser and yaml for user data, existing bwrap runner and quota-free OpenCode tests.
**Spec:** `docs/superpowers/specs/2026-10-25-selectable-kit-design.md`

## Global constraints

- Linux x86-64 only; preserve the installed source until tests/review pass.
- Planner writes only `docs/superpowers/specs`, `docs/superpowers/plans`, and scratch by default. Application source stays read-only.
- Imported explicit denials remain restrictive; unrecognized agent identities receive conservative access.
- Global policies prevent native agent shell fallback; project config cannot enlarge trusted capabilities.
- Setup preserves existing settings and JSONC comments; conflicts require keep/replace/rename choices.
- No credentials in exports, no execution of agent-pack scripts, and no publication without approval.

## Task 1: Trusted agent capabilities

Files: add `policy.mjs`, `test/policy.test.mjs`; update `index.js`, `config.mjs`, plugin/config tests.
Interfaces: `loadPolicy(file)`, `agentAccess(policy,id)`, `canEdit(access,target,scope)`, `policyPaths(home)`; plugin factory accepts a host-supplied policy path, never project-controlled policy overrides.
- [ ] Write failing tests for arbitrary reviewer names, explicit terminal denial, missing/invalid policy, planner edit scopes, and preserved deny effects.
- [ ] Run targeted tests; confirm failures are the missing capability enforcement.
- [ ] Implement trusted policy validation/loading and consistent native edit/escape enforcement; compile matching restrictive agent rules.
- [ ] Run `npm test`; expected full green suite. Commit task and record result.

## Task 2: Planner writable roots

Files: update `sandbox.mjs`, sandbox tests.
Interface: `runSandbox({..., readOnly, writablePaths})`; verified directory descriptors bind only selected planning roots.
- [ ] Write/run failing real-bwrap tests: create/write planning files, deny source edits, reject traversal/symlink roots, retain scratch writes.
- [ ] Implement confined directory preparation and pinned bind sources without privileged host mkdir through agent-controlled paths.
- [ ] Run `npm test`; expected green including existing containment/worktree/socket tests. Commit and ledger.

## Task 3: Data packs and conflict-aware composition

Files: add `kit/packs.mjs`, `kit/compose.mjs`, `packs/deniz-agents/`, focused tests.
Interfaces: `readAgentPack(source) -> pack`, `compose(existing,selection,resolutions) -> {config,policy,conflicts,files}`.
- [ ] Write/run failing tests for native Markdown/JSON packs, namespaced agents, invalid paths/links, declared profiles, JSONC preservation, keep/replace/rename, repeated composition and fresh empty config.
- [ ] Use established JSONC/YAML parsers; import only validated data from local directories or pinned GitHub sources. No lifecycle scripts or plugin code from agent packs.
- [ ] Supply optional Deniz agent/workflow presets; enable todo only as a visible selected dependency.
- [ ] Run all tests; expected green. Commit and ledger.

## Task 4: Reversible managed installation

Files: add `kit/install.mjs`, transaction tests.
Interfaces: `planInstall(paths,selection,resolutions)`, `applyPlan(plan)`, `removeComponent(...)`, `recover(...)`, `listInstalled(...)`.
- [ ] Write/run failing disposable-home tests for independent components, owned-entry removal, user-edit conflicts, config/profile/store protection, hash drift, rollback and interrupted transactions.
- [ ] Stage versioned code and data outside live discovery paths, record versions/hashes/ownership, preview a deterministic plan, and use an exclusive lock and journal for apply/recovery.
- [ ] Preserve unrelated files/settings; backup affected files; never overwrite a changed input or remove unowned data.
- [ ] Run all tests; expected green. Commit and ledger.

## Task 5: CLI and end-to-end checks

Files: add `cli.mjs`, `kit/doctor.mjs`, CLI tests; update package metadata, README, license and existing OpenCode integration fixtures.
- [ ] Write/run failing CLI tests for menu/flags, fresh setup, imported packs, unresolved noninteractive conflicts, list/remove/update, dry-run, platform rejection and doctor.
- [ ] Implement `init`, `add agents`, `list`, `remove`, `update`, `doctor` with option-based prompts and equivalent automation flags.
- [ ] Run `npm test` and `npm run test:opencode`; expected all green. Add real agent-tool checks for planner/imported profile enforcement and project override denial.
- [ ] Prepare/install-check a local npm tarball in a disposable home; no public publication. Commit and ledger.

## Review focus

Test the following in the owning tasks: project options overriding global capabilities; missing/symlink planning roots; renamed agents retaining permission denials; user-modified config during apply/remove; untrusted pack paths or scripts. Task 5 checks the actual OpenCode contract with a local scripted model.

After all tasks, one fresh reviewer reads the branch. Fix Important/Critical findings with regression tests in one pass, rerun relevant/full suites, and document remaining limitations. Prepare a concrete live migration and a shareable local release; retain all user data. No additional planning/review loop.
