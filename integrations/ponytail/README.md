# Ponytail text skills

MIT-licensed Ponytail 5.3.3 by Dietrich Gebert, from
https://github.com/DietrichGebert/ponytail/tree/v5.3.3.
`PROVENANCE.json` records hashes of the original imported skills and local
adaptations. Preserve `LICENSE` when distributing these files.

The kit adds this directory's `skills/` as a native OpenCode skill source.
There is no executable plugin, context hook, task board, webhook, or automatic
mode activation. The main `ponytail` skill has `opencode/autoinvoke: false`:
it stays registered for explicit loading but is not advertised to the model.
`ponytail-review` and `ponytail-audit` are discoverable; neither changes files.
Permission rules still control whether each agent can load a skill. Restricted
Chat agents keep their skill denial. Other authors' prompts remain untouched.

Use `@ponytail`, `@ponytail-review`, or `@ponytail-audit` in a prompt, or ask
the agent to load the exact skill ID. These are native skill mentions, not
new slash commands. Ponytail mode is conversation guidance after loading;
the kit does not reinject it on every turn or persist a mode setting to disk.

The debt/gain/help skills are omitted because the upstream ledger and benchmark
tools they describe are not part of this text-only component.
