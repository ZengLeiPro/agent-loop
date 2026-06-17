import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_DIR = '.agent-loop';
export const RUN_FILE = 'run.json';
export const DEFAULT_MAX_ROUNDS = 30;

export function stateDir(cwd = process.cwd()) {
  return resolve(cwd, STATE_DIR);
}

export function runFile(cwd = process.cwd()) {
  return join(stateDir(cwd), RUN_FILE);
}

export async function ensureStateDir(cwd = process.cwd()) {
  await mkdir(join(stateDir(cwd), 'logs'), { recursive: true });
}

export async function readRun(cwd = process.cwd()) {
  const path = runFile(cwd);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeRun(run, cwd = process.cwd()) {
  await ensureStateDir(cwd);
  const path = runFile(cwd);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function initProject({ cwd = process.cwd(), force = false } = {}) {
  await ensureStateDir(cwd);
  const existing = await readRun(cwd);
  if (existing && !force) {
    return { created: false, run: existing };
  }
  const now = new Date().toISOString();
  const run = {
    id: `run_${randomUUID().slice(0, 12)}`,
    app: 'agent-loop',
    version: 1,
    status: 'initialized',
    prompt: '',
    currentRound: 0,
    maxRounds: DEFAULT_MAX_ROUNDS,
    phases: [],
    createdAt: now,
    updatedAt: now
  };
  await writeRun(run, cwd);
  return { created: true, run };
}

export async function startRun({
  prompt,
  cwd = process.cwd(),
  maxRounds = DEFAULT_MAX_ROUNDS,
  dryRun = false,
  models = {},
  maxTurns = 50,
  permissionMode = 'acceptEdits',
  plannerOnly = false
} = {}) {
  if (!prompt || !prompt.trim()) throw new Error('A non-empty prompt is required.');
  await ensureStateDir(cwd);
  const now = new Date().toISOString();
  const run = {
    id: `run_${randomUUID().slice(0, 12)}`,
    app: 'agent-loop',
    version: 1,
    status: dryRun ? 'planned' : 'waiting-for-agent-adapter',
    prompt: prompt.trim(),
    currentRound: 0,
    maxRounds,
    maxTurns,
    permissionMode,
    plannerOnly,
    models: {
      planner: models.planner || 'default-planner',
      worker: models.worker || 'default-worker',
      judge: models.judge || 'default-judge'
    },
    phases: [{
      id: 'plan',
      role: 'planner',
      status: dryRun ? 'completed' : 'pending',
      startedAt: now,
      completedAt: dryRun ? now : undefined,
      note: dryRun
        ? 'Dry run created local state only. Agent adapters will be implemented next.'
        : 'Run created; waiting for an agent adapter implementation.'
    }],
    createdAt: now,
    updatedAt: now
  };
  await writeRun(run, cwd);
  await seedHarnessFiles(run, cwd);
  return run;
}

export async function seedHarnessFiles(run, cwd = process.cwd()) {
  const dir = stateDir(cwd);
  await ensureStateDir(cwd);
  const specPath = join(dir, 'spec.md');
  const prdPath = join(dir, 'prd.json');
  const progressPath = join(dir, 'progress.txt');
  if (!existsSync(specPath)) {
    await writeFile(specPath, `# Agent Loop Spec\n\nPrompt:\n\n${run.prompt || '(not set)'}\n`, 'utf8');
  }
  if (!existsSync(prdPath)) {
    await writeFile(prdPath, `${JSON.stringify({ userStories: [] }, null, 2)}\n`, 'utf8');
  }
  if (!existsSync(progressPath)) {
    await writeFile(progressPath, '', 'utf8');
  }
}

export function summarizeRun(run) {
  if (!run) return 'No agent-loop run exists in this directory yet.';
  return [
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    `Prompt: ${run.prompt || '(not set)'}`,
    `Round: ${run.currentRound}/${run.maxRounds}`,
    `Updated: ${run.updatedAt}`
  ].join('\n');
}
