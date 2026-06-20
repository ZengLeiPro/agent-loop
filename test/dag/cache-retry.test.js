import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRun, stateDir } from '../../src/core.js';
import { DagExecutor } from '../../src/dag/executor.js';
import { buildCacheKey, cachePath } from '../../src/dag/cache.js';

async function bareRun(cwd) {
  await startRun({ cwd, prompt: 'cache + retry test', dryRun: false });
  return JSON.parse(await readFile(join(cwd, '.agent-loop', 'run.json'), 'utf8'));
}

test('node-level retry recovers from transient failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-retry-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);

  let calls = 0;
  const flakyFactory = () => ({
    run: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`flaky fail ${calls}`);
      return { resultText: 'finally ok', sessionId: 's', totalCostUsd: 0 };
    }
  });

  const dag = {
    $schemaVersion: 1,
    name: 'retry-dag',
    concurrency: 1,
    nodes: [
      { id: 'flaky', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md',
        retries: { max: 3, backoffMs: 5 } }
    ]
  };

  const executor = new DagExecutor({
    dag, cwd, run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: flakyFactory
  });
  await executor.execute();
  assert.equal(calls, 3, `expected 3 attempts; saw ${calls}`);
  const node = run.nodes.find(n => n.id === 'flaky');
  assert.equal(node.status, 'completed');
});

test('node retries exhaust after max retries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-retry-exhaust-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);

  let calls = 0;
  const alwaysFails = () => ({ run: async () => { calls += 1; throw new Error('always fail'); } });

  const dag = {
    $schemaVersion: 1,
    name: 'exhaust',
    concurrency: 1,
    nodes: [
      { id: 'dead', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md',
        retries: { max: 2, backoffMs: 1 } }
    ]
  };
  const executor = new DagExecutor({
    dag, cwd, run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: alwaysFails
  });
  await assert.rejects(() => executor.execute(), /always fail/);
  assert.equal(calls, 3); // 1 original + 2 retries
  const node = run.nodes.find(n => n.id === 'dead');
  assert.equal(node.status, 'failed');
  assert.equal(node.attempts, 3);
});

test('node cache short-circuits a second execution when contract+inputs unchanged', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-cache-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');

  let calls = 0;
  const factory = () => ({ run: async () => { calls += 1; return { resultText: 'one', sessionId: '', totalCostUsd: 0 }; } });

  const dag = {
    $schemaVersion: 1,
    name: 'cache-dag',
    concurrency: 1,
    nodes: [
      { id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md',
        cache: { enabled: true } }
    ]
  };

  // First execution populates cache.
  const run1 = await bareRun(cwd);
  await new DagExecutor({
    dag, cwd, run: run1,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: factory
  }).execute();
  assert.equal(calls, 1);

  // Second execution: adapter should NOT be called; cache hit.
  const run2 = await bareRun(cwd);
  await new DagExecutor({
    dag, cwd, run: run2,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: factory
  }).execute();
  assert.equal(calls, 1, 'cache hit should prevent second adapter call');
  const cached = run2.nodes.find(n => n.id === 'a');
  assert.equal(cached.cacheHit, true);
});

test('buildCacheKey is stable and reflects upstream changes', () => {
  const node = { id: 'x', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'a.md', user: 'hi' };
  const a = buildCacheKey(node, { up: { text: 'one' } });
  const b = buildCacheKey(node, { up: { text: 'one' } });
  const c = buildCacheKey(node, { up: { text: 'two' } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('cachePath stays inside .agent-loop/cache/', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-cache-path-'));
  const path = cachePath(cwd, 'abc123');
  assert.match(path, /\.agent-loop\/cache\/abc123\.json$/);
});
