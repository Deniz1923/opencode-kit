# Usage Dashboard Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this tightly coupled implementation.

**Goal:** Implement and prepare the requested live usage dashboard without reading chats.
**Architecture:** Optional server/TUI plugin, bounded in-memory collector, snapshot/counter-reset RPC.
**Tech Stack:** JavaScript modules, OpenCode Promise hooks/RPC, Solid/OpenTUI.
**Spec:** `docs/superpowers/specs/2026-11-03-usage-dashboard-design.md`.

## Global Constraints

- Linux x86-64; initial validation on OpenCode 2.2.4.
- No transcripts, bodies, tool inputs/results, keys, messages or history backfill.
- Unknown provider data is unknown; no model calls or prompt additions.
- Existing sandbox and agent behavior remain intact.

## Review Focus

- Repeated/partial events must not double-count totals.
- Concurrent tools and sessions must not inflate wall time.
- Missing metrics and cache-zero normalization must not imply known billing/cache.
- Reconnect, session/model switches and descendants must retain honest scope.
- Optional install/update/removal and packed runtime must preserve user settings.

### 1. Collector and formatting

- [x] Add `test/usage.test.mjs`: deterministic metadata fixtures assert retry counts,
  merged intervals, deduplication, bounded state, descendants, reset, unknowns;
  forbidden payload getters throw if touched.
- [x] Run tests red; implement `integrations/usage/collector.mjs` and `format.mjs`;
  run green.

### 2. Server and UI

- [x] Add server registration/lifecycle tests and a real local-model integration
  asserting RPC usage while transcript access is forbidden.
- [x] Implement `integrations/usage/{index.js,rpc.js,package.json,tui.tsx}`.
- [x] Add `/usage-live`, refresh/reset/close, responsive session panel and route fallback;
  render from the collector snapshot only. Verify actual TUI loading and rendering
  with disposable config and synthetic sessions.

### 3. Installer and delivery

- [x] Add failing compose/install/CLI tests for usage-only, sandbox+usage, repeat,
  update and removal. Implement `--usage` and optional component copying.
- [x] Document metrics, scope, unknowns, usage and reset; run full tests and packed
  install checks. Obtain one focused independent code review and fix findings.
- [x] Prepare a concrete upgrade preview and activation instructions: no conflicts,
  existing agents/model preferences preserved, live config unchanged.
- Live apply/restart is deferred by the user's 2026-11-04 instruction while
  OpenCode is working. Source delivery proceeds independently.
