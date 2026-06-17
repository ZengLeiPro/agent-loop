# Frontend Experience Overhaul Plan

## Background

`agent-loop` currently exposes a lightweight local Web UI for starting Planner → Worker → Judge runs. The UI is functional, but its runtime experience is closer to a developer debugging console than a readable product workflow:

- Before Phase 2, the status panel rendered the raw `/api/status` response as formatted JSON.
- Before Phase 2, status refresh happened only on page load, manual refresh, or after a create-run request returned.
- Real runs are still executed inside the same `/api/run` HTTP request, so long-running work has no background job lifecycle or streaming feedback yet.
- Before Phase 1, the runner persisted state to `.agent-loop/run.json` and read completion artifacts from `.agent-loop/`, but bundled role prompts still instructed agents to write `.harness/` artifacts.

Phase 1 and Phase 2 addressed the prompt-directory mismatch and the primary raw-JSON status view. A follow-up added `--cwd` so users can choose the target project before starting CLI or Web UI commands. The remaining major experience gap is background execution plus event/log streaming.

## Goals

1. Make run progress readable without requiring users to inspect raw JSON.
2. Make real execution observable through background jobs and event/log streaming.
3. Keep raw JSON available for debugging, but demote it from the primary UI.
4. Align all runtime artifacts under `.agent-loop/` so Planner, Worker, Judge, runner, CLI, and Web UI share one protocol.
5. Preserve the local-first, low-dependency nature of the project.

## Non-goals for the first phase

- Replacing the static frontend with a large framework.
- Implementing remote multi-user persistence.
- Adding cloud authentication or hosted dashboards.
- Changing the agent loop semantics beyond fixing the artifact directory protocol.

## Original findings before Phase 1 / Phase 2

### Runtime state

- Main run state is stored in `.agent-loop/run.json`.
- Supporting artifacts live under `.agent-loop/`: `spec.md`, `prd.json`, `progress.txt`, `judge-<round>.md`, `logs/`, and `prompts/`.
- `runAgentPhase()` records phase-level status, timestamps, session ID, total cost, and error information in the run snapshot.
- `verifyRunCompletion()` checks `.agent-loop/progress.txt`, `.agent-loop/prd.json`, and `.agent-loop/judge-<round>.md`.

### Web UI

- `/api/status` returns a JSON snapshot: `{ cwd, stateDir, run }`.
- After Phase 2, `web/app.js` renders a structured summary and phase timeline while keeping `JSON.stringify(data, null, 2)` in a collapsed debug section.
- After Phase 2, the frontend auto-refreshes only active run states; SSE, WebSocket, and background task queues are still future work.
- `/api/run` currently starts dry runs quickly but still awaits full real execution when `dryRun` is disabled.

### Data protocol mismatch

- Core code, README, Web UI, templates, phase prompts, and bundled role prompts now use `.agent-loop/`.
- Existing editable prompts under `.agent-loop/prompts/` may predate this change, so Phase 1 includes a migration path that rewrites legacy `.harness` references when editable prompts are ensured.
- The state-protocol check now guards runtime files and template protocol references against `.harness` regressions.

## Phased implementation plan

### Phase 1 — Correctness foundation: unify artifact directory

**Objective:** ensure all agents and the orchestrator use `.agent-loop/` as the single canonical state directory.

Tasks:

- Replace `.harness` references in bundled Planner, Worker, and Judge prompts with `.agent-loop`.
- Keep existing `.agent-loop` behavior in core, runner, README, Web UI, and phase prompts.
- Add or update an automated check so accidental `.harness` reintroduction is caught.
- Run syntax checks and the new protocol check.
- Update this document with completion notes.

Acceptance criteria:

- `npm run check:state-protocol` reports no legacy `.harness` references in runtime protocol files (`prompts`, `src`, `templates`, `README.md`, `web`, and `package.json`) and verifies required `.agent-loop` protocol references.
- `npm run check` passes.
- A dedicated protocol check command passes.

### Phase 2 — Status dashboard MVP on existing API

**Objective:** improve readability without changing execution architecture yet.

Tasks:

- Replace the primary raw JSON status panel with a structured run overview.
- Add status badge, current round, current phase, timestamps, and latest error.
- Add a phase timeline using existing `run.phases` data.
- Keep raw JSON in a collapsed debug section.
- Add empty state and better request error display.
- Add basic `aria-live`, disabled, focus, and status styles.

Acceptance criteria:

- Users can understand the current run status without opening raw JSON.
- Raw JSON remains available for debugging.
- No backend API migration is required for this phase.

### Phase 3 — Background execution and event stream

**Objective:** make real runs observable while they execute.

Tasks:

- Split create-run and execute-run semantics internally.
- Add an in-process job manager for local Web UI execution.
- Connect `ClaudeAgentAdapter.run(... onEvent)` to runner-level event handling.
- Persist append-only run events, likely as NDJSON.
- Add an SSE endpoint for run events.
- Update frontend to show live logs and stop observing terminal runs.

Acceptance criteria:

- Starting a real run returns quickly with a run ID or equivalent status link.
- UI displays phase and agent output while execution is still ongoing.
- Page reload can recover current snapshot and recent events.

### Phase 4 — Artifact APIs and richer progress views

**Objective:** expose the evidence behind status and completion decisions.

Tasks:

- Add artifact endpoints for spec, PRD, progress, latest Judge report, and verification log.
- Render PRD stories as a table or board.
- Render latest Judge verdict and issues prominently.
- Add artifact refresh indicators and parse errors.

Acceptance criteria:

- Users can inspect spec, PRD story status, progress notes, and Judge reports from the UI.
- Completion decisions are explainable from visible artifacts.

### Phase 5 — Safer controls and prompt editing improvements

**Objective:** reduce accidental risky runs and make prompt editing safer.

Tasks:

- Add `bypassPermissions` confirmation when dry run is disabled.
- Reorganize create-run form into basic, safety, and advanced sections.
- Add prompt reset, unsaved-change warnings, and save success toast.
- Add placeholder validation for phase prompts.

Acceptance criteria:

- Dangerous permissions require explicit acknowledgement.
- Basic run path is obvious for new users.
- Prompt edits have recoverability and clear feedback.

## Project directory selection record

Implemented as a conservative first step before an in-browser directory picker:

- Added `--cwd PATH` to `init`, `run`, `status`, `verify`, and `ui`.
- The server still binds to one target project per UI process, preserving the local safety boundary.
- The Web dashboard now surfaces the bound project directory and state directory in the run summary.
- A browser-side arbitrary path picker remains future work and should be paired with project-root allowlists and stronger filesystem safety checks.

## Phase 2 progress record

Implemented an MVP dashboard on top of the existing `/api/status` endpoint:

- Replaced the primary raw JSON view with a structured run summary.
- Added status badges, round display, current phase, timestamps, permission/config fields, prompt preview, and latest error display.
- Added a phase timeline using existing `run.phases` data.
- Kept raw JSON available in a collapsed debug section.
- Added focused auto-refresh for active run states and improved request error handling.
- Added accessible status-region markup plus disabled/focus/status/timeline styles.
- Follow-up review hardened dynamic HTML rendering, class-token handling, and async auto-refresh error capture.

Remaining Phase 2 follow-ups:

- Add richer empty-state actions and field-level validation.
- Add more compact mobile refinements after broader visual testing.
- Preserve explicit success toasts independently from the status summary.

## Phase 1 completion record

Completed in this implementation pass:

- Bundled Planner, Worker, and Judge prompts now use `.agent-loop/` as the canonical artifact directory.
- Existing editable prompt files are migrated from `.harness` to `.agent-loop` when prompts are ensured.
- Added `scripts/check-state-protocol.js` to fail when runtime protocol files reintroduce `.harness` references and to assert required `.agent-loop` references in prompts/templates.
- Added `npm run check:state-protocol`, included it in `npm run check`, and added `web/app.js` plus the protocol script to syntax checks.
- Updated `verifyRunCompletion()` so the completion sentinel only counts on the final progress line, matching the Worker/Judge prompt contract.
- Verified that syntax checks, protocol checks, and runner completion tests pass.
