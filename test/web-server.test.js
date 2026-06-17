import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRun } from '../src/core.js';
import { createAgentLoopServer } from '../src/web-server.js';

async function withServer(cwd, fn) {
  const server = createAgentLoopServer({ cwd });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('review API reads and writes Planner checkpoint files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-review-'));
  await startRun({ cwd, prompt: 'review checkpoint', dryRun: true });

  await withServer(cwd, async baseUrl => {
    const initial = await (await fetch(`${baseUrl}/api/review`)).json();
    assert.match(initial.files.spec, /review checkpoint/);
    assert.match(initial.files.prd, /userStories/);

    const updated = await fetch(`${baseUrl}/api/review`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: { spec: '# Updated spec\n', prd: '{"userStories":[]}\n' } })
    });
    assert.equal(updated.status, 200);

    assert.equal(await readFile(join(cwd, '.agent-loop', 'spec.md'), 'utf8'), '# Updated spec\n');
    assert.equal(await readFile(join(cwd, '.agent-loop', 'prd.json'), 'utf8'), '{"userStories":[]}\n');
  });
});

test('resume API rejects runs that are not waiting for review', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-resume-'));
  await startRun({ cwd, prompt: 'resume checkpoint', dryRun: true, plannerOnly: true });

  await withServer(cwd, async baseUrl => {
    const conflict = await fetch(`${baseUrl}/api/resume`, { method: 'POST' });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /waiting for review/);
  });
});
