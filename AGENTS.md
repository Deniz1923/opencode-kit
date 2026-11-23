# OpenCode Kit

Start with the [project handoff](docs/project-handoff.md) for the current
release, architecture, live setup, verification, and open work. Use the
[README](README.md) for install and update commands.

- Work from this checkout. The earlier sandbox and kit checkouts shared one
  Git history. Historical implementation notes and the old branch are in Git.
- Keep credentials, live configuration, chats, backups, and generated artifacts
  out of Git. Do not inspect saved chats. Use disposable config and model
  sessions for tests.
- Preview upgrades before changing the live OpenCode installation. Preserve
  existing settings and permissions. Check for active work before restarting.
- Run focused checks first. For installer, sandbox, or runtime changes, run
  `npm test` on a supported host before release. Use real model requests when
  authorized and record the model and the outcome separately from scripted tests.
