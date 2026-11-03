# Usage dashboard

User requested full implementation of the illustrated request/token/retry/timing
dashboard. Linux x86-64, OpenCode 2.2.4 is the initial tested target.

Build an optional `usage` kit component with its own server/TUI plugin. `/usage-live`
opens a live session panel, with a fullscreen route fallback. Track each session,
the latest execution and observed descendants; report per-agent/model rows.
Keep the sandbox and agent prompts unchanged.

Subscribe to session creation/deletion, execution/step/compaction boundaries,
and content-free text/reasoning/tool-input start markers. Select metadata only,
ignoring compaction summaries and native payloads. Observe model/HTTP request and retry hooks plus
tool timing hooks. Never read request/response bodies, transcript APIs, message
events, tool input/output, or old databases. Keep bounded counters in memory;
show the tracking start and explicitly mark incomplete observations after reload.
Internal auxiliary usage is not public: count title/generate requests but mark
their token/cost usage unavailable. Read compaction usage from its public boundary.
Reopening an existing session starts observing new work, without backfilling.

Show host-normalized token counts, cached/uncached input, output/reasoning,
OpenCode cost, request and retry counters, safe retry reason categories, model
stream/wait time and tool wall time. Concurrent intervals are merged, and their
overlap is disclosed. Unknown provider metrics remain unknown: OpenCode normalizes
absent cache fields to zero and can estimate costs, so zero cache counts cannot
prove no caching and host cost cannot prove actual billing. Failed attempts may
have unreported token usage. Titles/compaction are separately identified.

Approaches considered: TUI-only tracking loses visibility while closed; parsing
response streams risks touching chat contents and changing inference; live
server metadata observation plus read-only RPC retains visibility across UI
reconnects without either problem. Use the latter, with no extra model calls.

Installer supports `--usage` independently of sandbox/agents, update/remove,
backup and conflict handling. Package all runtime/TUI files. Expose a snapshot
RPC and in-memory counter reset; no application-state writes, agent tool or
injected instructions. UI refreshes only while visible and
disposes polling on close. No remote analytics or durable usage history.
