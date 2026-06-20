import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initProject, readRun, startRun, summarizeRun } from './core.js';
import { runAgentLoop, verifyRunCompletion } from './runner.js';
import { serve } from './web-server.js';
import { validateRunOptions } from './validation.js';
import { listTemplates } from './dag/templates.js';

function printHelp() {
  console.log([
    'agent-loop',
    '',
    'Usage:',
    '  agent-loop init [--cwd PATH] [--force]',
    '  agent-loop run <prompt> [--cwd PATH] [--max-rounds N] [--dry-run] [--planner-only] [--template NAME] [--planner-model M] [--worker-model M] [--judge-model M] [--permission-mode MODE]',
    '  agent-loop plan <prompt> [--cwd PATH]                  # use meta-planner agent to produce a custom DAG',
    '  agent-loop resume [--cwd PATH]',
    '  agent-loop status [--cwd PATH]',
    '  agent-loop templates [--cwd PATH]',
    '  agent-loop verify [--cwd PATH] [--round N]',
    '  agent-loop ui [--cwd PATH] [--port N] [--host HOST]',
    '',
    'A local-first, standalone Agent Loop runner with a bundled web UI. Use --cwd PATH to target a project directory without changing shell directories. Real runs use @anthropic-ai/claude-agent-sdk after dependencies are installed.'
  ].join('\n'));
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
    const prompt = stripFlags(
      rest,
      new Set(['--cwd', '--max-rounds', '--max-turns', '--planner-model', '--worker-model', '--judge-model', '--permission-mode', '--template']),
      new Set(['--dry-run', '--planner-only'])
    ).join(' ');
    const options = validateRunOptions({
      prompt,
      maxRounds: readFlag(rest, '--max-rounds', '30'),
      maxTurns: readFlag(rest, '--max-turns', '50'),
      permissionMode: readFlag(rest, '--permission-mode', 'acceptEdits'),
      plannerOnly: rest.includes('--planner-only'),
      template: readFlag(rest, '--template', undefined),
      models: modelFlags(rest)
    }, { cwd });
    if (rest.includes('--dry-run')) {
      const run = await startRun({ ...options, dryRun: true });
      console.log('Created agent-loop dry run.');
      console.log(summarizeRun(run));
      return;
    }
    const run = await runAgentLoop(options);
    console.log('agent-loop run finished or paused.');
    console.log(summarizeRun(run));
    return;
  }
  if (command === 'plan') {
    const prompt = stripFlags(rest, new Set(['--cwd']), new Set()).join(' ');
    if (!prompt.trim()) throw new Error('plan requires a non-empty prompt.');
    console.log('Running meta-planner template to produce .agent-loop/templates/dynamic.json ...');
    await runAgentLoop({ cwd, prompt: prompt.trim(), template: 'meta-planner', maxRounds: 1, plannerOnly: false });
    console.log('Done. Next step:');
    console.log(`  agent-loop run "<your prompt>" --template dynamic --cwd ${cwd}`);
    return;
  }
  if (command === 'templates') {
    const items = await listTemplates(cwd);
    if (!items.length) {
      console.log('No templates found.');
      return;
    }
    for (const item of items) {
      console.log(`${item.name.padEnd(30)} ${item.source.padEnd(8)} ${item.path}`);
    }
    return;
  }
  if (command === 'resume') {
    const run = await runAgentLoop({ cwd, plannerOnly: false });
    console.log('agent-loop resumed and finished or paused.');
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
