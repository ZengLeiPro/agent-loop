import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const binPath = resolve('bin/agent-loop.js');

test('run --dry-run --cwd writes state into the selected project directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-cli-cwd-'));
  await execFileAsync(process.execPath, [binPath, 'run', 'check cwd support', '--dry-run', '--cwd', cwd]);

  const runPath = join(cwd, '.agent-loop', 'run.json');
  assert.equal(existsSync(runPath), true);
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  assert.equal(run.prompt, 'check cwd support');
  assert.equal(run.status, 'planned');
});

test('status --cwd reads state from the selected project directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-cli-status-cwd-'));
  await execFileAsync(process.execPath, [binPath, 'run', 'status cwd support', '--dry-run', '--cwd', cwd]);
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'status', '--cwd', cwd]);

  assert.match(stdout, /Prompt: status cwd support/);
  assert.match(stdout, /Status: planned/);
});
