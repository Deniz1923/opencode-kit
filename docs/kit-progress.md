# Execution ledger — selectable kit

Plan: docs/superpowers/plans/2026-10-25-selectable-kit.md
Spec: docs/superpowers/specs/2026-10-25-selectable-kit-design.md
Base: f35339f

Execution: inline, authorized by Deniz's instruction to go ahead. Existing live source is preserved in a separate local worktree; development is on branch selectable-kit.

Preflight interfaces: trusted policy -> plugin and composer; validated agent data -> composer; composition -> transaction planner; transaction -> CLI/doctor. Keep native shell hard policy and capability enforcement inseparable from sandbox installation.

- Task 1: complete. Trusted profiles, arbitrary agent identities, native edit scopes, explicit terminal/escape denial and safe unknown-agent fallback implemented. RED tests observed; `npm test` passes 31/31. Migration idempotence regression fixed at its undefined prompt-field source.
- Task 2: complete. Planner output roots are prepared inside bwrap, checked for symlinks, and mounted from pinned directory descriptors. Source and nested Git metadata remain read-only. RED tests observed; `npm test` passes 34/34.
- Task 3: complete. Validated native packs, explicit conflict choices, renamed references/profiles and JSONC-preserving composition implemented. Optional Deniz agents contain prompt data only. RED tests observed; full suite passes 45/45.
- Task 4: complete. Versioned private code, ownership-aware config removal, stale-preview rejection, backups, locks, rollback and interrupted-transaction recovery implemented. Manual policy/code changes are detected. RED tests observed; suite passes 51/51.
- Task 5: complete. Option-based CLI, independent selections, updates/removal, doctor, Linux compatibility gates, package metadata/license/docs and CI added. `npm test` passes 58/58, including an offline installed tarball; `npm run test:opencode` passes 16/16, including positive native Plan writes and source-edit rejection. Packaging caught/fixed the npm executable-symlink entrypoint. Doctor's external probe now uses a host-visible /var/tmp parent rather than private /tmp.

Final review: one fresh reviewer, three Important findings, no Critical or minor findings. All three fixed with RED→GREEN regressions: reject interpolation throughout pack data; retain scoped shell restrictions for both replacement tools, including renamed agents; mask installer state/backups and hard-deny native reads. `npm test` passes 62/62, including installed `doctor --full` with 19 real OpenCode checks. Full doctor writes only private temporary artifacts and does not modify installed package code. No extra review round.

Live migration approved and applied on 2026-10-25. Existing prompts/plugins and delegation depth 2 preserved; todo enabled; managed code and trusted policy installed. OpenCode restarted successfully. Live doctor passes and authenticated read-only service checks confirm the sandbox, goal plugin and Superpowers active, with todo enabled and depth 2. Backup: ~/.config/opencode-kit/backups/2026-10-25T15-15-47-707Z-9849d57b-6a12-4afa-afeb-f7afc713cccc. The live plugin now points to versioned managed code, not a development checkout. Publishing remains separate and unapproved. Development branch/worktree retained; no public remote or PR created.

Ruling: Preserve the user's already-authorized inline execution instead of asking for another plan/execution-method approval. Cost if wrong: adjust implementation against the approved spec, with tests and reversible staging.

Ruling: Continue in the already-created sibling Git worktree, preserving the live source. The host lists no managed worktree attachments; do not create another checkout. Cost: this worktree is tracked by Git rather than the host attachment UI.
