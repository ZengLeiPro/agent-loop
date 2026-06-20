// runner.js —— 把所有调度委托给 DAG executor，只负责：
// 1. start/resume run；
// 2. git preflight；
// 3. lock 管理；
// 4. plannerOnly checkpoint（执行完前置节点后停止等待人工 review）；
// 5. 模板加载（默认 ralph-compound）。
//
// verifyRunCompletion 已移到 src/verify-completion.js；这里 re-export 保持向后兼容。

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_MAX_ROUNDS, readRun, seedHarnessFiles, startRun, stateDir, writeRun } from './core.js';
import { writeEvidence } from './evidence.js';
import { appendEvent } from './events.js';
import { gitPreflight } from './git-safety.js';
import { readEditablePrompts, ensureEditablePrompts, systemPromptFile, PROMPT_ROLES } from './prompts.js';
import { clearControl } from './control.js';
import { assertCurrentRun, clearRunLock, writeRunLock } from './run-lock.js';
import { DagExecutor } from './dag/executor.js';
import { loadTemplate } from './dag/templates.js';

// Re-export for callers that imported it from runner.js historically (CLI, web-server).
export { verifyRunCompletion } from './verify-completion.js';

const RALPH_PRE_REVIEW_NODES = ['planner']; // nodes to run before review-loop in plannerOnly mode.

async function resolveSystemPromptFile({ promptRef, cwd }) {
  // promptRef like "ralph-compound/planner.md" → map to one of the editable role prompts.
  const fileName = promptRef.split('/').pop().replace(/\.md$/, '');
  if (PROMPT_ROLES.includes(fileName)) {
    return systemPromptFile(cwd, fileName);
  }
  // Fallback: write the bundled prompt into .agent-loop/prompts/<base>.md once, then return it.
  const localPath = join(stateDir(cwd), 'prompts', `${fileName}.md`);
  if (!existsSync(localPath)) {
    const bundledPath = join(dirname(new URL(import.meta.url).pathname), '..', 'prompts', promptRef);
    const bundled = await readFile(bundledPath, 'utf8');
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, bundled, 'utf8');
  }
  return localPath;
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
  template: templateName,
  sdk = {},
  publishEvent
} = {}) {
  const emit = publishEvent || (event => appendEvent(cwd, event));
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
  await seedHarnessFiles(run, cwd);

  // Git preflight: block on dirty if requireClean=true.
  const preflight = await gitPreflight({ cwd, requireClean: requireCleanGit });
  run.gitPreflight = preflight;
  await writeEvidence(cwd, 'git-preflight', preflight);
  await emit({
    type: 'git_preflight',
    runId: run.id,
    blocked: preflight.blocked,
    dirty: preflight.dirty,
    isGitRepo: preflight.isGitRepo,
    risks: preflight.risks
  });
  if (preflight.blocked) {
    run.status = 'blocked';
    run.updatedAt = new Date().toISOString();
    await assertCurrentRun(cwd, run.id);
    await writeRun(run, cwd);
    await clearRunLock(cwd, { runId: run.id });
    return run;
  }

  // Load editable prompts (initializes .agent-loop/prompts/<role>.md if missing) so per-role overrides exist on disk.
  await ensureEditablePrompts(cwd);
  await readEditablePrompts(cwd);

  // Load DAG template. Default = ralph-compound.
  const effectiveTemplateName = templateName || run.template || 'ralph-compound';
  const { dag } = await loadTemplate(effectiveTemplateName, { cwd });
  run.template = effectiveTemplateName;

  // Compose models: per-run + per-call overrides, keyed by ralph role names (planner/worker/judge).
  const effectiveModels = { ...run.models, ...models };
  const effectiveMaxTurns = maxTurns ?? run.maxTurns ?? 50;
  const effectivePermissionMode = permissionMode ?? run.permissionMode ?? 'acceptEdits';

  await writeRunLock(cwd, { runId: run.id, type: 'dag' });
  run.status = 'running';
  await assertCurrentRun(cwd, run.id);
  await writeRun(run, cwd);

  // Phase 1: pre-review (planner). Stop here if plannerOnly.
  if (plannerOnly) {
    const executor = new DagExecutor({
      dag,
      cwd,
      run,
      input: { prompt: run.prompt },
      models: effectiveModels,
      adapterDefaults: { maxTurns: effectiveMaxTurns, permissionMode: effectivePermissionMode, ...sdk },
      toolOverrides: allowedTools || {},
      systemPromptResolver: resolveSystemPromptFile,
      publishEvent: emit,
      runOnly: RALPH_PRE_REVIEW_NODES
    });
    try {
      await executor.execute();
      run.status = 'waiting-for-review';
      run.updatedAt = new Date().toISOString();
      await assertCurrentRun(cwd, run.id);
      await writeRun(run, cwd);
      return run;
    } catch (error) {
      run.status = 'failed';
      run.updatedAt = new Date().toISOString();
      run.lastError = error instanceof Error ? error.message : String(error);
      await writeRun(run, cwd);
      await clearRunLock(cwd, { runId: run.id });
      throw error;
    }
  }

  // Otherwise: run the full DAG. If planner already ran in a previous plannerOnly invocation, skip it.
  const plannerAlreadyDone = (run.nodes || []).some(node => node.id === 'planner' && node.status === 'completed');
  const runOnly = plannerAlreadyDone
    ? dag.nodes.map(node => node.id).filter(id => id !== 'planner')
    : null;

  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    input: { prompt: run.prompt },
    models: effectiveModels,
    adapterDefaults: { maxTurns: effectiveMaxTurns, permissionMode: effectivePermissionMode, ...sdk },
    toolOverrides: allowedTools || {},
    systemPromptResolver: resolveSystemPromptFile,
    publishEvent: emit,
    runOnly
  });

  try {
    const runtime = await executor.execute();
    // Inspect verify outcome to decide terminal status. Ralph-compound writes verify under iteration-suffixed id.
    const verifyOutputs = (run.nodes || []).filter(node => node.nodeRef === 'verify' && node.status === 'completed');
    const lastVerify = verifyOutputs.at(-1);
    if (lastVerify) {
      // Reload the latest verify output JSON for completion check.
      const verifyJson = runtime.getNode('verify')?.json;
      if (verifyJson?.complete) run.status = 'completed';
      else run.status = 'max_rounds_reached';
    } else {
      // No verify node ran (non-ralph template). Mark completed when all top-level nodes succeeded.
      run.status = 'completed';
    }
  } catch (error) {
    run.status = 'failed';
    run.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    run.updatedAt = new Date().toISOString();
    await assertCurrentRun(cwd, run.id);
    await writeRun(run, cwd);
    await clearRunLock(cwd, { runId: run.id });
  }
  return run;
}
