import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRun, stateDir } from '../../src/core.js';
import { DagExecutor } from '../../src/dag/executor.js';
import { readLatestNodeOutput } from '../../src/dag/output-store.js';

// Mock adapter that returns a deterministic resultText based on the model id.
function mockAdapterFactory(traces = []) {
  return options => ({
    run: async ({ prompt, role, cwd, onEvent }) => {
      traces.push({ model: options.model, role, prompt, cwd, allowedTools: options.allowedTools });
      onEvent?.({ type: 'text', text: `from ${options.model}` });
      return {
        resultText: `output of ${options.model}`,
        sessionId: `sess_${options.model}`,
        totalCostUsd: 0.001
      };
    }
  });
}

async function bareRun(cwd) {
  await startRun({ cwd, prompt: 'unit test', dryRun: false });
  // Re-read via core readRun (skip — we mutate the in-memory run object inside executor).
  return JSON.parse(await import('node:fs/promises').then(m => m.readFile(join(cwd, '.agent-loop', 'run.json'), 'utf8')));
}

test('DagExecutor runs a 3-node serial DAG', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-serial-'));
  // Pre-seed editable prompt files so systemPromptResolver finds them.
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  await writeFile(join(stateDir(cwd), 'prompts', 'worker.md'), '# worker\n', 'utf8');
  const run = await bareRun(cwd);

  const traces = [];
  const dag = {
    $schemaVersion: 1,
    name: 'serial',
    concurrency: 1,
    nodes: [
      { id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md', user: '{{input.prompt}}' },
      { id: 'b', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'ralph-compound/worker.md', inputs: ['a'], user: 'continue: {{nodes.a.text}}' }
    ]
  };

  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    input: { prompt: 'unit test' },
    models: { planner: 'm-planner', worker: 'm-worker' },
    systemPromptResolver: async ({ promptRef }) => join(stateDir(cwd), 'prompts', promptRef.endsWith('planner.md') ? 'planner.md' : 'worker.md'),
    adapterFactory: mockAdapterFactory(traces)
  });

  const runtime = await executor.execute();
  assert.equal(traces.length, 2);
  assert.equal(traces[0].model, 'm-planner');
  assert.equal(traces[1].model, 'm-worker');
  // b sees a's output via template.
  assert.equal(traces[1].prompt, 'continue: output of m-planner');
  assert.equal(runtime.getNode('a').text, 'output of m-planner');
  assert.equal(runtime.getNode('b').text, 'output of m-worker');
  // Output file landed.
  const persisted = await readLatestNodeOutput(cwd, 'a');
  assert.equal(persisted.text, 'output of m-planner');
});

test('DagExecutor runs parallel readers concurrently respecting concurrency cap', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-parallel-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);

  const inFlight = { current: 0, peak: 0 };
  const slowMockFactory = options => ({
    run: async ({ onEvent }) => {
      inFlight.current += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.current);
      await new Promise(resolve => setTimeout(resolve, 25));
      inFlight.current -= 1;
      onEvent?.({ type: 'text', text: `done ${options.model}` });
      return { resultText: `r-${options.model}`, sessionId: `s-${options.model}`, totalCostUsd: 0 };
    }
  });

  const dag = {
    $schemaVersion: 1,
    name: 'parallel-readers',
    concurrency: 3,
    nodes: [
      { id: 'r1', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
      { id: 'r2', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
      { id: 'r3', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' }
    ]
  };

  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: slowMockFactory
  });
  await executor.execute();
  assert.equal(inFlight.peak, 3, `expected 3 concurrent runs, saw ${inFlight.peak}`);
});

test('DagExecutor respects concurrency=1 (serial even when no edges)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-serial-cap-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);

  const inFlight = { current: 0, peak: 0 };
  const slowMockFactory = options => ({
    run: async () => {
      inFlight.current += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.current);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight.current -= 1;
      return { resultText: '', sessionId: '', totalCostUsd: 0 };
    }
  });

  const dag = {
    $schemaVersion: 1,
    name: 'serial-cap',
    concurrency: 1,
    nodes: [
      { id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
      { id: 'b', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' }
    ]
  };
  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: slowMockFactory
  });
  await executor.execute();
  assert.equal(inFlight.peak, 1);
});

test('DagExecutor surfaces a failing node and writes error to run.nodes[]', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-fail-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);

  const dag = {
    $schemaVersion: 1,
    name: 'failing',
    concurrency: 1,
    nodes: [
      { id: 'broken', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' }
    ]
  };

  const failingFactory = () => ({ run: async () => { throw new Error('boom'); } });

  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: failingFactory
  });

  await assert.rejects(() => executor.execute(), /boom/);
  const node = run.nodes.find(n => n.id === 'broken');
  assert.equal(node.status, 'failed');
  assert.match(node.error, /boom/);
});

test('DagExecutor runs a loop with tool node and verifies until condition', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-loop-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'worker.md'), '# worker\n', 'utf8');
  const run = await bareRun(cwd);

  const iterations = [];
  const workerFactory = options => ({
    run: async () => {
      iterations.push(options.model);
      return { resultText: `iter ${iterations.length}`, sessionId: 's', totalCostUsd: 0 };
    }
  });

  const dag = {
    $schemaVersion: 1,
    name: 'with-loop',
    concurrency: 1,
    nodes: [
      {
        id: 'lp',
        type: 'loop',
        maxIterations: 5,
        iterationVar: 'round',
        iterationStart: 1,
        until: 'loop.round >= 3',
        subgraph: [
          { id: 'worker', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'ralph-compound/worker.md' },
          { id: 'echo', type: 'tool', tool: 'echo', args: { round: '{{loop.round}}' }, inputs: ['worker'] }
        ]
      }
    ]
  };
  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'worker.md'),
    adapterFactory: workerFactory
  });
  await executor.execute();
  assert.equal(iterations.length, 3); // until triggers after round 3 finishes
  // verify per-iteration outputs persisted
  const iter1 = await readLatestNodeOutput(cwd, 'lp[1].worker');
  assert.equal(iter1.text, 'iter 1');
  const iter3Echo = await readLatestNodeOutput(cwd, 'lp[3].echo');
  assert.equal(iter3Echo.json.round, '3');
});

test('DagExecutor supports gather node combining upstream outputs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-gather-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);
  let i = 0;
  const factory = () => ({ run: async () => { i += 1; return { resultText: `R${i}`, sessionId: '', totalCostUsd: 0 }; } });
  const dag = {
    $schemaVersion: 1,
    name: 'gather',
    concurrency: 2,
    nodes: [
      { id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
      { id: 'b', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
      { id: 'g', type: 'gather', inputs: ['a', 'b'] }
    ]
  };
  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: factory
  });
  const runtime = await executor.execute();
  const gathered = runtime.getNode('g').json;
  assert.deepEqual(Object.keys(gathered), ['a', 'b']);
  assert.match(gathered.a.text, /^R[12]$/);
  assert.match(gathered.b.text, /^R[12]$/);
});

test('DagExecutor honors runOnly to limit top-level scheduling (plannerOnly path)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-dag-runonly-'));
  await mkdir(join(stateDir(cwd), 'prompts'), { recursive: true });
  await writeFile(join(stateDir(cwd), 'prompts', 'planner.md'), '# planner\n', 'utf8');
  const run = await bareRun(cwd);

  const calls = [];
  const factory = options => ({ run: async () => { calls.push(options.model); return { resultText: 'x', sessionId: '', totalCostUsd: 0 }; } });
  const dag = {
    $schemaVersion: 1,
    name: 'runonly',
    concurrency: 1,
    nodes: [
      { id: 'planner', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' },
      { id: 'worker-loop', type: 'loop', maxIterations: 1, subgraph: [
        { id: 'worker', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'ralph-compound/planner.md' }
      ]}
    ]
  };
  const executor = new DagExecutor({
    dag,
    cwd,
    run,
    systemPromptResolver: async () => join(stateDir(cwd), 'prompts', 'planner.md'),
    adapterFactory: factory,
    runOnly: ['planner']
  });
  await executor.execute();
  assert.deepEqual(calls, ['planner']); // worker not invoked
});
