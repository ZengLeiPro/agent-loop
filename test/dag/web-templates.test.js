import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentLoopServer } from '../../src/web-server.js';

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

test('GET /api/templates lists bundled ralph-compound', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-templates-list-'));
  await withServer(cwd, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/templates`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.templates));
    assert.ok(body.templates.some(item => item.name === 'ralph-compound' && item.source === 'bundled'));
  });
});

test('GET /api/templates/:name returns validated DAG', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-templates-get-'));
  await withServer(cwd, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/templates/ralph-compound`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dag.name, 'ralph-compound');
    assert.equal(body.dag.nodes[0].id, 'planner');
  });
});

test('PUT /api/templates/:name saves user-template and validates DAG', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-templates-put-'));
  await withServer(cwd, async baseUrl => {
    const dag = {
      $schemaVersion: 1,
      name: 'parallel-readers',
      nodes: [
        { id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
        { id: 'b', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' }
      ]
    };
    const ok = await fetch(`${baseUrl}/api/templates/parallel-readers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dag })
    });
    assert.equal(ok.status, 200);
    const persisted = await (await fetch(`${baseUrl}/api/templates/parallel-readers`)).json();
    assert.equal(persisted.dag.name, 'parallel-readers');

    // Invalid schema rejected
    const bad = await fetch(`${baseUrl}/api/templates/broken`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dag: { $schemaVersion: 1, name: 'broken', nodes: [] } })
    });
    assert.equal(bad.status, 400);
  });
});

test('GET /api/templates/:name 404 for unknown name', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-templates-404-'));
  await withServer(cwd, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/templates/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error, /not found/);
  });
});

test('/dag and /editor page paths fall back to index.html', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-web-templates-pages-'));
  await withServer(cwd, async baseUrl => {
    for (const page of ['/dag', '/editor']) {
      const response = await fetch(`${baseUrl}${page}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
    }
  });
});
