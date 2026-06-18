import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir, stateDir } from './core.js';
import { ValidationError } from './validation.js';

export function controlFile(cwd = process.cwd()) {
  return join(stateDir(cwd), 'control.json');
}

export async function readControl(cwd = process.cwd()) {
  const file = controlFile(cwd);
  if (!existsSync(file)) return { action: 'none' };
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeControl(cwd = process.cwd(), control = {}) {
  const action = control.action;
  if (!['cancel', 'pause-after-current-phase', 'none'].includes(action)) {
    throw new ValidationError('control action must be one of: cancel, pause-after-current-phase, none.');
  }
  await ensureStateDir(cwd);
  const payload = {
    action,
    requestedAt: new Date().toISOString(),
    reason: typeof control.reason === 'string' ? control.reason.trim() : undefined
  };
  await writeFile(controlFile(cwd), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export async function clearControl(cwd = process.cwd()) {
  return writeControl(cwd, { action: 'none' });
}

export async function shouldStopAfterPhase(cwd = process.cwd()) {
  const control = await readControl(cwd);
  return control.action === 'cancel' || control.action === 'pause-after-current-phase' ? control : null;
}
