import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initProject, readRun, startRun, summarizeRun } from './core.js';
import { runAgentLoop, verifyRunCompletion } from './runner.js';
import { serve } from './web-server.js';

function printHelp() {
  console.log(`agent-loop\n\nUsage:\n  agent-loop init [--cwd PATH] [--force]\n  agent-loop run <prompt> [--cwd PATH] [--max-rounds N] [--dry-run] [--planner-only] [--planner-model M] [--worker-model M] [--judge-model M] [--permission-mode MODE]\n  agent-loop status [--cwd PATH]\n  agent-loop verify [--cwd PATH] [--round N]\n  agent-loop ui [--cwd PATH] [--port N] [--host HOST]\n\nA local-first, standalone Agent Loop runner with a bundled web UI. Use --cwd PATH to target a project directory without changing shell directories. Real runs use @anthropic-ai/claude-agent-sdk after dependencies are installed.`);
}

function readFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function stripFlags(args, flagsWithValues, booleanFlags) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (booleanFlags.has(item)) continue;
    if (flagsWithValues.has(item)) {
      index += 1;
      continue;
    }
    output.push(item);
  }
  return output;
}

async function targetCwd(args) {
  const cwd = resolve(readFlag(args, '--cwd', process.cwd()));
  const stats = await stat(cwd);
  if (!stats.isDirectory()) throw new Error(`--cwd must point to a directory: ${cwd}`);
  return cwd;
}

function modelFlags(args) {
  return {
    planner: readFlag(args, '--planner-model', undefined),
    worker: readFlag(args, '--worker-model', undefined),
    judge: readFlag(args, '--judge-model', undefined)
  };
}

export async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') return printHelp();
  const cwd = await targetCwd(rest);
  if (command === 'init') {
    const result = await initProject({ cwd, force: rest.includes('--force') });
    console.log(result.created ? 'Initialized agent-loop state.' : 'agent-loop state already exists.');
    console.log(summarizeRun(result.run));
    return;
  }
  if (command === 'run') {
    const maxRounds = Number(readFlag(rest, '--max-rounds', '30'));
    const maxTurns = Number(readFlag(rest, '--max-turns', '50'));
    const permissionMode = readFlag(rest, '--permission-mode', 'acceptEdits');
    const prompt = stripFlags(
      rest,
      new Set(['--cwd', '--max-rounds', '--max-turns', '--planner-model', '--worker-model', '--judge-model', '--permission-mode']),
      new Set(['--dry-run', '--planner-only'])
    ).join(' ');
    if (rest.includes('--dry-run')) {
      const run = await startRun({ prompt, cwd, maxRounds, dryRun: true });
      console.log('Created agent-loop dry run.');
      console.log(summarizeRun(run));
      return;
    }
    const run = await runAgentLoop({
      cwd,
      prompt,
      maxRounds,
      maxTurns,
      permissionMode,
      plannerOnly: rest.includes('--planner-only'),
      models: modelFlags(rest)
    });
    console.log('agent-loop run finished or paused.');
    console.log(summarizeRun(run));
    return;
  }
  if (command === 'status') {
    console.log(summarizeRun(await readRun(cwd)));
    return;
  }
  if (command === 'verify') {
    const round = Number(readFlag(rest, '--round', String((await readRun(cwd))?.currentRound ?? 0)));
    console.log(JSON.stringify(await verifyRunCompletion(cwd, round), null, 2));
    return;
  }
  if (command === 'ui') {
    const port = Number(readFlag(rest, '--port', process.env.AGENT_LOOP_PORT || '4317'));
    const host = readFlag(rest, '--host', process.env.AGENT_LOOP_HOST || '127.0.0.1');
    const { url } = await serve({ cwd, port, host });
    console.log(`agent-loop UI running at ${url}`);
    console.log(`Target project: ${cwd}`);
    return;
  }
  throw new Error(`Unknown command: ${command}. Run agent-loop --help.`);
}
