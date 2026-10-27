# Forge quality upgrade — 27 October 2026

Implemented `design_preflight`, `audit_design`, `get_build_checkpoint` and
`commit_build_checkpoint`, plus source-grounded workflow/font guidance in FORGE.md.

Validation: 11 tests pass (`npm test --prefix server`); `bun run check` passes
server build, plugin typecheck/build and repository formatting.

Live typed MCP calls on the connected file verified SF Pro Text Regular installed
and loadable, bounded structural audit and empty checkpoint lookup. No product
nodes were edited. Checkpoint mutation/replay/conflicts/concurrent writes are
covered by tests with a mocked Figma API; no live checkpoint mutation was attempted.

A live instance lookup hit Figma's 10-second connection failure. The audit reported
lookup failure, not a missing main. A subsequent change adds `maxDurationMs`
(default 5000) and returns `complete:false,timedOut:true` for slow lookups. Its hung
lookup regression passes. Reopen the development plugin to load this latest build.

Audit is structural and bounded, not visual acceptance. Checkpoint commits record
progress and stable IDs; they do not make drawing scripts transactional or undoable.
Read FORGE.md for the complete generate/audit/screenshot/checkpoint workflow.

Companion imagegen upgrade is tracked in ../codex-imagegen-mcp/UPGRADE-PLAN.md.
No commit/push or host MCP registration changes were made.
