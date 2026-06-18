import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaudeAgentAdapter } from './claude-agent-adapter.js';
import { DEFAULT_MAX_ROUNDS, readRun, seedHarnessFiles, startRun, stateDir, writeRun } from './core.js';
import { writeEvidence, readJsonIfExists, writeJudgeVerdictJson } from './evidence.js';
import { appendEvent } from './events.js';
import { collectGitEvidence, gitPreflight } from './git-safety.js';
import { allowedToolsForRole } from './policy.js';
import { readEditablePrompts, renderPhasePrompt, systemPromptFile } from './prompts.js';
import { clearControl, shouldStopAfterPhase } from './control.js';

async function appendFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const previous = existsSync(path) ? await readFile(path, 'utf8') : '';
  await writeFile(path, `${previous}${content}`, 'utf8');
}

function stalePlannerPlaceholder(phase) {
  return phase?.id === 'plan' && phase.role === 'planner' && phase.status === 'pending';
}

function dropStalePlannerPlaceholders(run) {
  run.phases = (run.phases || []).filter(phase => !stalePlannerPlaceholder(phase));
}

async function applyControlAfterPhase(cwd, run) {
  const control = await shouldStopAfterPhase(cwd);
  if (!control) return false;
  run.status = control.action === 'cancel' ? 'cancelled' : 'paused';
  run.control = control;
  run.updatedAt = new Date().toISOString();
  await writeRun(run, cwd);
  await appendEvent(cwd, { type: 'control', action: control.action, status: run.status });
  return true;
}

async function runAgentPhase({ adapter, cwd, run, role, round, prompt, systemPromptFile }) {
  const startedAt = new Date().toISOString();
  const normalizedRound = round ?? 0;
  const phaseId = `${role}-${normalizedRound}`;
  const phaseIndex = (run.phases || []).findIndex(phase => (
    phase.role === role
    && phase.status === 'pending'
    && (phase.round ?? 0) === normalizedRound
  ));
  const phase = {
    id: phaseId,
    role,
    round: normalizedRound,
    status: 'running',
    startedAt
  };
  if (phaseIndex === -1) {
    run.phases.push(phase);
  } else {
    run.phases[phaseIndex] = phase;
  }
  run.status = 'running';
  run.updatedAt = startedAt;
  await writeRun(run, cwd);
  await appendEvent(cwd, { type: 'phase_start', phaseId, role, round: normalizedRound });

  if (role === 'worker') {
    const beforeGit = await collectGitEvidence({ cwd, phaseId, role, round: normalizedRound, moment: 'before' });
    phase.gitBefore = await writeEvidence(cwd, `${phaseId}-git-before`, beforeGit);
    await writeRun(run, cwd);
    await appendEvent(cwd, { type: 'git_evidence', phaseId, role, round: normalizedRound, moment: 'before', evidencePath: phase.gitBefore });
  }

  try {
    const result = await adapter.run({
      cwd,
      role,
      prompt,
      systemPromptFile,
      onEvent: event => appendEvent(cwd, { ...event, type: `agent_${event.type || 'event'}`, phaseId, role, round: normalizedRound })
    });
    if (role === 'worker') {
      const afterGit = await collectGitEvidence({ cwd, phaseId, role, round: normalizedRound, moment: 'after' });
      phase.gitAfter = await writeEvidence(cwd, `${phaseId}-git-after`, afterGit);
      await appendEvent(cwd, { type: 'git_evidence', phaseId, role, round: normalizedRound, moment: 'after', evidencePath: phase.gitAfter });
    }
    phase.status = 'completed';
    phase.completedAt = new Date().toISOString();
    phase.sessionId = result.sessionId;
    phase.totalCostUsd = result.totalCostUsd;
    run.updatedAt = phase.completedAt;
    await writeRun(run, cwd);
    await appendEvent(cwd, { type: 'phase_end', phaseId, role, round: normalizedRound, status: 'completed' });
    return result;
  } catch (error) {
    if (role === 'worker') {
      const afterGit = await collectGitEvidence({ cwd, phaseId, role, round: normalizedRound, moment: 'after-failed' });
      phase.gitAfter = await writeEvidence(cwd, `${phaseId}-git-after-failed`, afterGit);
      await appendEvent(cwd, { type: 'git_evidence', phaseId, role, round: normalizedRound, moment: 'after-failed', evidencePath: phase.gitAfter });
    }
    phase.status = 'failed';
    phase.completedAt = new Date().toISOString();
    phase.error = error instanceof Error ? error.message : String(error);
    run.status = 'failed';
    run.updatedAt = phase.completedAt;
    await writeRun(run, cwd);
    await appendEvent(cwd, { type: 'phase_end', phaseId, role, round: normalizedRound, status: 'failed', error: phase.error });
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
  const structuredJudge = await readJsonIfExists(join(dir, `judge-${round}.json`));
  let judgeOk = false;
  let judgeSource = 'markdown';
  if (structuredJudge?.verdict) {
    judgeOk = String(structuredJudge.verdict).toUpperCase() === 'PASS';
    judgeSource = 'json';
  } else {
    const verdictMatches = [...judge.matchAll(/VERDICT\s*:\s*(PASS|FAIL)/gi)];
    judgeOk = verdictMatches.length > 0 && verdictMatches.at(-1)[1].toUpperCase() === 'PASS';
  }

  return { sentinelOk, passCountOk, judgeOk, judgeSource, complete: sentinelOk && passCountOk && judgeOk };
}

export async function runAgentLoop({
  cwd = process.cwd(),
  prompt,
  maxRounds,
  models = {},
  maxTurns,
  permissionMode,
  allowedTools,
  requireCleanGit = process.env.AGENT_LOOP_GIT_REQUIRE_CLEAN === 'true',
  plannerOnly = false,
  sdk = {}
} = {}) {
  let run = await readRun(cwd);
  const startingNewRun = !run || prompt;
  if (startingNewRun) {
    await clearControl(cwd);
    run = await startRun({
      prompt,
      cwd,
      maxRounds: maxRounds ?? DEFAULT_MAX_ROUNDS,
      dryRun: false,
      models,
      maxTurns: maxTurns ?? 50,
      permissionMode: permissionMode ?? 'acceptEdits',
      plannerOnly
    });
  } else {
    run.plannerOnly = plannerOnly;
    run.updatedAt = new Date().toISOString();
    await writeRun(run, cwd);
  }
  dropStalePlannerPlaceholders(run);
  await seedHarnessFiles(run, cwd);
  const preflight = await gitPreflight({ cwd, requireClean: requireCleanGit });
  run.gitPreflight = preflight;
  await writeEvidence(cwd, 'git-preflight', preflight);
  await appendEvent(cwd, {
    type: 'git_preflight',
    blocked: preflight.blocked,
    dirty: preflight.dirty,
    isGitRepo: preflight.isGitRepo,
    risks: preflight.risks
  });
  if (preflight.blocked) {
    run.status = 'blocked';
    run.updatedAt = new Date().toISOString();
    await writeRun(run, cwd);
    return run;
  }
  const editablePrompts = await readEditablePrompts(cwd);
  const effectiveMaxRounds = maxRounds ?? run.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const effectiveMaxTurns = maxTurns ?? run.maxTurns ?? 50;
  const effectivePermissionMode = permissionMode ?? run.permissionMode ?? 'acceptEdits';
  const effectiveModels = { ...run.models, ...models };

  const adapterFor = role => new ClaudeAgentAdapter({
    model: effectiveModels[role],
    maxTurns: effectiveMaxTurns,
    permissionMode: effectivePermissionMode,
    ...sdk,
    allowedTools: allowedToolsForRole(role, allowedTools)
  });

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

  if (await applyControlAfterPhase(cwd, run)) return run;

  if (plannerOnly) {
    run.status = 'waiting-for-review';
    run.updatedAt = new Date().toISOString();
    await writeRun(run, cwd);
    return run;
  }

  for (let round = Math.max(1, run.currentRound || 1); round <= effectiveMaxRounds; round += 1) {
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
    if (await applyControlAfterPhase(cwd, run)) return run;

    await runAgentPhase({
      adapter: adapterFor('judge'),
      cwd,
      run,
      role: 'judge',
      round,
      prompt: renderPhasePrompt(editablePrompts.phasePrompts.judge, { round, prompt: run.prompt }),
      systemPromptFile: systemPromptFile(cwd, 'judge')
    });
    const judgeVerdict = await writeJudgeVerdictJson({ cwd, round });
    await appendEvent(cwd, { type: 'judge_verdict', round, verdict: judgeVerdict.verdict, pass: judgeVerdict.pass });
    if (await applyControlAfterPhase(cwd, run)) return run;

    const verification = await verifyRunCompletion(cwd, round);
    await appendFile(join(stateDir(cwd), 'logs', 'verification.log'), `${new Date().toISOString()} round=${round} ${JSON.stringify(verification)}\n`);
    await appendEvent(cwd, { type: 'verification', round, verification });
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
