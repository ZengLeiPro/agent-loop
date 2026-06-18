import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './core.js';

export const ACTIVE_RUN_STATUSES = new Set([
  'waiting-for-agent-adapter',
  'running',
  'waiting-for-review',
  'paused'
]);

export function lockFile(cwd = process.cwd()) {
  return join(stateDir(cwd), 'lock.json');
}

export async function readRunLock(cwd = process.cwd()) {
  const file = lockFile(cwd);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeRunLock(cwd = process.cwd(), lock = {}) {
  const file = lockFile(cwd);
  await mkdir(dirname(file), { recursive: true });
  const payload = {
    acquiredAt: lock.acquiredAt || new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    pid: process.pid,
    ...lock
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export async function touchRunLock(cwd = process.cwd(), updates = {}) {
  const existing = await readRunLock(cwd);
  if (!existing) return null;
  return writeRunLock(cwd, { ...existing, ...updates, heartbeatAt: new Date().toISOString() });
}

export async function clearRunLock(cwd = process.cwd(), { runId } = {}) {
  const existing = await readRunLock(cwd);
  if (runId && existing?.runId && existing.runId !== runId) return false;
  await rm(lockFile(cwd), { force: true });
  return true;
}

export function isActiveRun(run) {
  return Boolean(run && ACTIVE_RUN_STATUSES.has(run.status));
}

export async function assertCurrentRun(cwd = process.cwd(), runId) {
  const lock = await readRunLock(cwd);
  if (lock?.runId && lock.runId !== runId) {
    throw new Error(`Run lock belongs to ${lock.runId}; refusing to update stale run ${runId}.`);
  }
}
