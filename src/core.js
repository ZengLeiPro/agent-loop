import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAndValidatePrdJson } from './prd-schema.js';
import { migrateRun, RUN_SCHEMA_VERSION } from './dag/migration.js';

export const STATE_DIR = '.agent-loop';
export const RUN_FILE = 'run.json';
export const DEFAULT_MAX_ROUNDS = 30;
export const REVIEW_FILES = { spec: 'spec.md', prd: 'prd.json' };

export function stateDir(cwd = process.cwd()) {
  return resolve(cwd, STATE_DIR);
}

export function runFile(cwd = process.cwd()) {
  return join(stateDir(cwd), RUN_FILE);
}

export async function ensureStateDir(cwd = process.cwd()) {
  await Promise.all([
    mkdir(join(stateDir(cwd), 'logs'), { recursive: true }),
    mkdir(join(stateDir(cwd), 'diffs'), { recursive: true }),
    mkdir(join(stateDir(cwd), 'evidence'), { recursive: true })
  ]);
}

export async function readRun(cwd = process.cwd()) {
  const path = runFile(cwd);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return migrateRun(raw);
}

export async function writeRun(run, cwd = process.cwd()) {
  await ensureStateDir(cwd);
  const path = runFile(cwd);
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`;
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
    schemaVersion: RUN_SCHEMA_VERSION,
    template: 'ralph-compound',
    status: 'initialized',
    prompt: '',
    currentRound: 0,
    maxRounds: DEFAULT_MAX_ROUNDS,
    phases: [],
    nodes: [],
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
  plannerOnly = false,
  template = 'ralph-compound'
} = {}) {
  if (!prompt || !prompt.trim()) throw new Error('A non-empty prompt is required.');
  await ensureStateDir(cwd);
  const now = new Date().toISOString();
  const phases = dryRun ? [{
    id: 'plan',
    role: 'planner',
    status: 'completed',
    startedAt: now,
    completedAt: now,
    note: 'Dry run created local state only. Agent adapters will be implemented next.'
  }] : [];
  const nodes = dryRun ? [{
    id: 'planner',
    nodeRef: 'planner',
    iteration: 0,
    status: 'completed',
    startedAt: now,
    completedAt: now,
    note: 'Dry run created local state only. Agent adapters will be implemented next.',
    legacyPhaseId: 'plan',
    legacyRole: 'planner',
    legacyRound: 0
  }] : [];
  const run = {
    id: `run_${randomUUID().slice(0, 12)}`,
    app: 'agent-loop',
    version: 1,
    schemaVersion: RUN_SCHEMA_VERSION,
    template,
    status: dryRun ? 'planned' : 'waiting-for-agent-adapter',
    prompt: prompt.trim(),
    currentRound: 0,
    maxRounds,
    maxTurns,
    permissionMode,
    plannerOnly,
    models: {
      // 未显式指定时留 undefined,下游 adapter 不传 --model,SDK 走 token holder 默认模型。
      // 之前填 'default-*' 字面值会被 adapter 当真 model id 传给 API,导致 404 not_found_error。
      planner: models.planner,
      worker: models.worker,
      judge: models.judge
    },
    phases,
    nodes,
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

function reviewFilePath(cwd, key) {
  const filename = REVIEW_FILES[key];
  if (!filename) throw new Error('review file must be one of: spec, prd.');
  return join(stateDir(cwd), filename);
}

export async function readReviewFiles(cwd = process.cwd()) {
  await ensureStateDir(cwd);
  return Object.fromEntries(await Promise.all(
    Object.keys(REVIEW_FILES).map(async key => {
      const path = reviewFilePath(cwd, key);
      return [key, existsSync(path) ? await readFile(path, 'utf8') : ''];
    })
  ));
}

export async function writeReviewFiles({ cwd = process.cwd(), files = {} } = {}) {
  await ensureStateDir(cwd);
  for (const key of Object.keys(REVIEW_FILES)) {
    if (Object.hasOwn(files, key)) {
      const value = String(files[key]);
      if (key === 'prd') parseAndValidatePrdJson(value);
      await writeFile(reviewFilePath(cwd, key), value, 'utf8');
    }
  }
  return readReviewFiles(cwd);
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
