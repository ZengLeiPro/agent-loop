# agent-loop

`agent-loop` is a standalone, local-first Agent Loop project intended to be split out into its own GitHub repository later. It packages a simple CLI and a lightweight web UI together, without depending on the parent application.

## Goals

- Keep the project self-contained under this directory.
- Run locally on macOS from a Git checkout.
- Provide a generic Planner → Worker → Judge loop foundation.
- Store project-local state in `.agent-loop/` inside the target repository.
- Bundle a small web UI for people who prefer not to drive everything from the CLI.

## Current status

This is still an early implementation slice, but it is no longer just a state-only scaffold:

- dependency-light Node.js CLI;
- local HTTP server and bundled static web UI;
- local run-state creation;
- embedded Ralph Compound-style template and prompt placeholders;
- initial `@anthropic-ai/claude-agent-sdk` adapter;
- initial Planner → Worker → Judge runner loop;
- completion verification using sentinel + PRD pass count + Judge verdict.

Important limitations:

- Live runs require `npm install` in this folder after splitting/checking out the project.
- Live runs require Claude Agent SDK credentials and whatever local tool permissions your SDK setup needs.
- Git safety checks, rollback, pause/resume/cancel, and robust per-round diff review are still next steps.
- The web UI is localized in Simplified Chinese, can start a live run, can pass run configuration (round/turn limits, permission mode, planner-only mode, and per-role models), and can edit the local agent/system and phase prompt templates used by future runs. Long-running live execution is currently a simple HTTP request rather than a streamed job queue.

## Usage

From this folder:

```bash
npm install
node ./bin/agent-loop.js --help
node ./bin/agent-loop.js init
node ./bin/agent-loop.js run "Add a small feature" --dry-run
node ./bin/agent-loop.js run "Add a small feature" --planner-only
node ./bin/agent-loop.js run "Add a small feature" --planner-model claude-opus-4-1 --worker-model claude-sonnet-4-5 --judge-model claude-opus-4-1 --permission-mode acceptEdits
node ./bin/agent-loop.js verify
node ./bin/agent-loop.js status
node ./bin/agent-loop.js ui
```

Then open <http://127.0.0.1:4317>. The Simplified Chinese UI exposes the same core run configuration as the CLI: max rounds, max turns, permission mode, planner-only mode, and planner/worker/judge model overrides. These values are submitted to `/api/run` and persisted into `.agent-loop/run.json` for the created run. The prompt editor loads and saves editable prompt files under `.agent-loop/prompts/`; saved agent system prompts and phase task prompt templates are used by subsequent live runs.

## Scripts

```bash
npm run check
npm run smoke
npm start
```

## Local state

`agent-loop` writes target-project state to `.agent-loop/`:

```text
.agent-loop/
  run.json
  spec.md
  prd.json
  progress.txt
  judge-<round>.md
  logs/
  prompts/
    planner.md
    worker.md
    judge.md
    phase-prompts.json
```

## Planned next steps

1. Validate the default Claude Agent SDK permission/tool policy against the exact internal environment.
2. Add Git safety checks and per-round commit/diff tracking.
3. Add pause/resume/cancel commands.
4. Convert web live execution to a background job with streamed logs.
5. Add tests around verification and loop recovery.
