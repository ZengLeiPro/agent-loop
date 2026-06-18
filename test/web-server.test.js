import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

test('static file server rejects path traversal attempts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-static-'));

  await withServer(cwd, async baseUrl => {
    const response = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);
    assert.equal(response.status, 403);
  });
});

test('run API validates JSON and request body size', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-body-'));

  await withServer(cwd, async baseUrl => {
    const badJson = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(badJson.status, 400);

    const tooLarge = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x'.repeat(1024 * 1024 + 1) })
    });
    assert.equal(tooLarge.status, 413);
  });
});

test('run API starts a background job and exposes events', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-job-'));

  await withServer(cwd, async baseUrl => {
    const created = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'queue this dry run' })
    });
    assert.equal(created.status, 201);
    const payload = await created.json();
    assert.equal(payload.run.prompt, 'queue this dry run');
    assert.match(payload.job.id, /^job_/);

    await new Promise(resolve => setTimeout(resolve, 50));
    const events = await (await fetch(`${baseUrl}/api/events`)).json();
    assert.equal(events.events.some(event => event.type === 'job.queued' && event.runId === payload.run.id), true);
  });
});

test('control API records pause-after-current-phase marker', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-control-'));

  await withServer(cwd, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause-after-current-phase', reason: 'operator review' })
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.control.action, 'pause-after-current-phase');

    const current = await (await fetch(`${baseUrl}/api/control`)).json();
    assert.equal(current.control.reason, 'operator review');
  });
});

test('artifacts API exposes quality gate and evidence summaries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-artifacts-'));
  await startRun({ cwd, prompt: 'artifact summary', dryRun: true });
  const stateDir = join(cwd, '.agent-loop');
  await mkdir(join(stateDir, 'evidence'), { recursive: true });
  await writeFile(join(stateDir, 'judge-1.json'), '{"verdict":"PASS"}\n', 'utf8');
  await writeFile(join(stateDir, 'evidence', 'worker-1-git-after.json'), JSON.stringify({
    moment: 'after',
    changedFiles: [{ status: ' M', path: 'src/example.js' }],
    diffStat: 'src/example.js | 1 +'
  }), 'utf8');

  await withServer(cwd, async baseUrl => {
    const payload = await (await fetch(`${baseUrl}/api/artifacts`)).json();
    assert.equal(payload.artifacts.qualityGate.verdict, 'PASS');
    assert.equal(payload.artifacts.evidence.some(item => item.name === 'worker-1-git-after'), true);
  });
});
