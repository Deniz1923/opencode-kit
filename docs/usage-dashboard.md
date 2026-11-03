# Live usage dashboard

The optional usage component adds `/usage-live` (alias `/kit-usage`) and the
**Live request usage and retries** command-palette entry. Open a session first.
OpenCode's built-in `/usage` and `/stats` commands remain available.

```sh
# Preview, then install when your current OpenCode work has finished.
node cli.mjs init --usage --dry-run
node cli.mjs init --usage --apply --restart

# Later updates or removal:
node cli.mjs update usage --apply --restart
node cli.mjs remove usage --apply --restart
```

It can be installed on its own or combined with sandbox and agent components.
It requires Linux x86-64, Node.js 22+, and OpenCode 2.2.4. Bubblewrap is only
needed if the sandbox component is selected. Applying creates the usual managed
backup; preview never changes live settings.

## Reading the panel

The dashboard refreshes once per second while visible. It uses the session
panel where supported, with a full-page fallback. Escape closes it, `r` refreshes
it, and Ctrl+R offers to reset only the displayed session family's counters.
Reset is refused while observed work is running. Closing the dashboard stops UI
polling; the server continues collecting metadata while its plugin is loaded.

- **Latest request:** model/variant, total and uncached input, cache reads/writes,
  visible output, reasoning, first output-stream boundary latency and OpenCode's
  cost figure. A stream-start marker precedes its content; this is not a claim
  about the exact first-token arrival time.
- **Observed session family:** totals for the selected session and observed
  descendants, including agents, models, model calls, HTTP attempts and retries.
- **Timing:** observed primary-model wait/stream and tool wall time. Overlapping intervals
  are merged, including parallel descendants. Model/tool categories can overlap
  one another, so their durations must not be added to infer elapsed time.
  Tool wall time includes permission waits and orchestration; it is not process
  CPU time.
- **Retries:** safe reason categories such as upstream idle timeout or rate
  limit, plus the latest physical attempt number. Retry decisions are unchanged.
- **Auxiliary calls:** title/compaction/generate call counts are identified
  separately from the latest primary response. Public compaction boundaries
  supply its tokens/cost. Title and transient-generation usage is unavailable
  through public metadata and marked unreported; totals are known subtotals.
  Auxiliary request time is excluded from primary-model wall time.

Counts start when this plugin observes activity. They are session/run counters,
not account-wide invoice totals. Existing sessions are not backfilled; restart,
plugin reload and manual reset begin a fresh observation window. The UI shows
that window's start. Switching models does not merge their breakdown rows.

OpenCode reports uncached input separately from cached reads and writes. The
displayed input total adds those three counts. OpenCode also normalizes missing
cache fields to zero, so a reported zero is shown as **unknown**, rather than
asserting that no caching occurred. Its cost figure can be provider-reported or
calculated from catalog prices; actual **provider billing remains unknown**.
Missing metrics and unreported failed-attempt usage are not guessed.

## Privacy and resource use

The plugin subscribes to live session/step/compaction boundaries, content-free
output-start markers, and request/retry/tool-boundary hooks. It selects only
counts, identifiers and timing. Compaction summary/native fields are ignored.
It does not call conversation APIs, read request or response bodies, subscribe
to message events or content deltas, inspect tool inputs/results, read
credentials, or retrieve historical conversations. There
are no extra model calls, prompt additions, analytics uploads or durable usage
files. Existing native application behavior is unchanged.

State is bounded to 100 observed sessions, 512 recent step/interval entries per
session, and 32 agent/model groups per session. When observations exceed these
limits, the dashboard marks incomplete data; unavailable complete timing becomes
unknown. Summaries remain in server memory until unload/restart. Fresh activity
is required after reconnecting to a restarted server.

## Validation

```sh
npm test
npm run test:opencode
npm run test:usage-ui
```

The package test installs offline, so its dependency metadata and tarballs must
already be cached. To prepare a dedicated test cache without installing anything
globally:

```sh
npm cache add 'jsonc-parser@^3.3.1' 'yaml@^2.9.1' --cache .artifacts/test-npm-cache --ignore-scripts
npm_config_cache="$PWD/.artifacts/test-npm-cache" npm test
```

The terminal smoke test starts a private OpenCode instance and local scripted
model with disposable config/data/state. It opens the actual `/usage-live` panel
and verifies rendered counters, billing provenance and agent breakdown. It uses
no provider quota and does not connect to the user's live server.

Validated 2026-11-04: 114 suite tests passed, including the packaged install and
32 disposable OpenCode agent integration cases; the actual terminal smoke test
also passed. Independent review corrections cover public auxiliary-event
availability, output-start latency and auxiliary model attribution. The live
setup preview had no conflicts and preserved existing agents/model preferences.
Live activation was deliberately deferred while the user's OpenCode was working.
