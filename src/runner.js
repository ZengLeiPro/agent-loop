import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaudeAgentAdapter } from './claude-agent-adapter.js';
import { DEFAULT_MAX_ROUNDS, readRun, seedHarnessFiles, startRun, stateDir, writeRun } from './core.js';
import { readEditablePrompts, renderPhasePrompt, systemPromptFile } from './prompts.js';

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
  const progressLastLine = progress.trimEnd().split(/\r?\n/).at(-1) || '';
  const sentinelOk = /^<promise>\s*COMPLETE\s*<\/promise>$/i.test(progressLastLine);

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
  plannerOnly = false,
  sdk = {}
} = {}) {
  let run = await readRun(cwd);
  if (!run || prompt) {
    run = await startRun({ prompt, cwd, maxRounds, dryRun: false, models, maxTurns, permissionMode, plannerOnly });
  }
  await seedHarnessFiles(run, cwd);
  const editablePrompts = await readEditablePrompts(cwd);

  const adapterFor = role => new ClaudeAgentAdapter({ model: models[role], maxTurns, permissionMode, ...sdk });

  if (!run.phases.some(phase => phase.role === 'planner' && phase.status === 'completed')) {
    await runAgentPhase({
      adapter: adapterFor('planner'),
      cwd,
      run,
      role: 'planner',
      prompt: renderPhasePrompt(editablePrompts.phasePrompts.planner, { prompt: run.prompt }),
      systemPromptFile: systemPromptFile(cwd, 'planner')
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
      prompt: renderPhasePrompt(editablePrompts.phasePrompts.worker, { round, prompt: run.prompt }),
      systemPromptFile: systemPromptFile(cwd, 'worker')
    });

    await runAgentPhase({
      adapter: adapterFor('judge'),
      cwd,
      run,
      role: 'judge',
      round,
      prompt: renderPhasePrompt(editablePrompts.phasePrompts.judge, { round, prompt: run.prompt }),
      systemPromptFile: systemPromptFile(cwd, 'judge')
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
