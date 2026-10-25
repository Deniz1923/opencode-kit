# Execution ledger — selectable kit

Plan: docs/superpowers/plans/2026-10-25-selectable-kit.md
Spec: docs/superpowers/specs/2026-10-25-selectable-kit-design.md
Base: f35339f

Execution: inline, authorized by Deniz's instruction to go ahead. Existing live source is preserved at /home/deniz/Projects/opencode-sandbox; development is on branch selectable-kit.

Preflight interfaces: trusted policy -> plugin and composer; validated agent data -> composer; composition -> transaction planner; transaction -> CLI/doctor. Keep native shell hard policy and capability enforcement inseparable from sandbox installation.

- Task 1: complete. Trusted profiles, arbitrary agent identities, native edit scopes, explicit terminal/escape denial and safe unknown-agent fallback implemented. RED tests observed; `npm test` passes 31/31. Migration idempotence regression fixed at its undefined prompt-field source.
- Task 2: complete. Planner output roots are prepared inside bwrap, checked for symlinks, and mounted from pinned directory descriptors. Source and nested Git metadata remain read-only. RED tests observed; `npm test` passes 34/34.
- Task 3: complete. Validated native packs, explicit conflict choices, renamed references/profiles and JSONC-preserving composition implemented. Optional Deniz agents contain prompt data only. RED tests observed; full suite passes 45/45.
- Task 4: complete. Versioned private code, ownership-aware config removal, stale-preview rejection, backups, locks, rollback and interrupted-transaction recovery implemented. Manual policy/code changes are detected. RED tests observed; suite passes 51/51.
- Task 5: pending.

Ruling: Preserve the user's already-authorized inline execution instead of asking for another plan/execution-method approval. Cost if wrong: adjust implementation against the approved spec, with tests and reversible staging.

Ruling: Continue in the already-created sibling Git worktree, preserving the live source. The host lists no managed worktree attachments; do not create another checkout. Cost: this worktree is tracked by Git rather than the host attachment UI.
