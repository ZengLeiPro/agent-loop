import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAgentAdapter } from './claude-agent-adapter.js';
import { DEFAULT_MAX_ROUNDS, readRun, seedHarnessFiles, startRun, stateDir, writeRun } from './core.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(__dirname, '..');
const promptsRoot = join(projectRoot, 'prompts', 'ralph-compound');

function promptFile(name) {
  return join(promptsRoot, name);
}

async function appendFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const previous = existsSync(path) ? await readFile(path, 'utf8') : '';
  await writeFile(path, `${previous}${content}`, 'utf8');
}

async function runAgentPhase({ adapter, cwd, run, role, round, prompt, systemPromptFile }) {
  const startedAt = new Date().toISOString();
  const phase = {
    id: `${role}-${round ?? 0}`,
    role,
    round: round ?? 0,
    status: 'running',
    startedAt
  };
  run.phases.push(phase);
  run.status = 'running';
  run.updatedAt = startedAt;
  await writeRun(run, cwd);

  try {
    const result = await adapter.run({ cwd, role, prompt, systemPromptFile });
    phase.status = 'completed';
    phase.completedAt = new Date().toISOString();
    phase.sessionId = result.sessionId;
    phase.totalCostUsd = result.totalCostUsd;
    run.updatedAt = phase.completedAt;
    await writeRun(run, cwd);
    return result;
  } catch (error) {
    phase.status = 'failed';
    phase.completedAt = new Date().toISOString();
    phase.error = error instanceof Error ? error.message : String(error);
    run.status = 'failed';
    run.updatedAt = phase.completedAt;
    await writeRun(run, cwd);
    throw error;
  }
}

export async function verifyRunCompletion(cwd = process.cwd(), round = 0) {
  const dir = stateDir(cwd);
  const progressPath = join(dir, 'progress.txt');
  const prdPath = join(dir, 'prd.json');
  const judgePath = join(dir, `judge-${round}.md`);

  const progress = existsSync(progressPath) ? await readFile(progressPath, 'utf8') : '';
  const sentinelOk = /<promise>\s*COMPLETE\s*<\/promise>/i.test(progress);

  let passCountOk = false;
  if (existsSync(prdPath)) {
    const prd = JSON.parse(await readFile(prdPath, 'utf8'));
    const stories = Array.isArray(prd.userStories) ? prd.userStories : [];
    passCountOk = stories.length > 0 && stories.every(story => story?.passes === true);
  }

  const judge = existsSync(judgePath) ? await readFile(judgePath, 'utf8') : '';
  const verdictMatches = [...judge.matchAll(/VERDICT\s*:\s*(PASS|FAIL)/gi)];
  const judgeOk = verdictMatches.length > 0 && verdictMatches.at(-1)[1].toUpperCase() === 'PASS';

  return { sentinelOk, passCountOk, judgeOk, complete: sentinelOk && passCountOk && judgeOk };
}

export async function runAgentLoop({
  cwd = process.cwd(),
  prompt,
  maxRounds = DEFAULT_MAX_ROUNDS,
  models = {},
  maxTurns = 50,
  permissionMode = 'acceptEdits',
  plannerOnly = false
} = {}) {
  let run = await readRun(cwd);
  if (!run || prompt) {
    run = await startRun({ prompt, cwd, maxRounds, dryRun: false });
  }
  await seedHarnessFiles(run, cwd);

  const adapterFor = role => new ClaudeAgentAdapter({ model: models[role], maxTurns, permissionMode });

  if (!run.phases.some(phase => phase.role === 'planner' && phase.status === 'completed')) {
    await runAgentPhase({
      adapter: adapterFor('planner'),
      cwd,
      run,
      role: 'planner',
      prompt: `Create .agent-loop/spec.md and .agent-loop/prd.json for this request:\n\n${run.prompt}`,
      systemPromptFile: promptFile('planner.md')
    });
  }

  if (plannerOnly) {
    run.status = 'waiting-for-review';
    run.updatedAt = new Date().toISOString();
    await writeRun(run, cwd);
    return run;
  }

  for (let round = Math.max(1, run.currentRound || 1); round <= maxRounds; round += 1) {
    run.currentRound = round;
    await writeRun(run, cwd);

    await runAgentPhase({
      adapter: adapterFor('worker'),
      cwd,
      run,
      role: 'worker',
      round,
      prompt: `Round ${round}. Read .agent-loop/spec.md and .agent-loop/prd.json. Implement exactly one unfinished story, update bookkeeping, and commit.`,
      systemPromptFile: promptFile('worker.md')
    });

    await runAgentPhase({
      adapter: adapterFor('judge'),
      cwd,
      run,
      role: 'judge',
      round,
      prompt: `Round ${round}. Audit the latest worker round and write .agent-loop/judge-${round}.md ending in VERDICT: PASS or VERDICT: FAIL.`,
      systemPromptFile: promptFile('judge.md')
    });

    const verification = await verifyRunCompletion(cwd, round);
    await appendFile(join(stateDir(cwd), 'logs', 'verification.log'), `${new Date().toISOString()} round=${round} ${JSON.stringify(verification)}\n`);
    if (verification.complete) {
      run.status = 'completed';
      run.updatedAt = new Date().toISOString();
      await writeRun(run, cwd);
      return run;
    }
  }

  run.status = 'max_rounds_reached';
  run.updatedAt = new Date().toISOString();
  await writeRun(run, cwd);
  return run;
}
