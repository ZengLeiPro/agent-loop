import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAndValidateDag, validateDag, normalizeDag, DAG_SCHEMA_VERSION, iterateAllNodes, nodeContractHash } from '../../src/dag/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphTemplatePath = resolve(__dirname, '..', '..', 'templates', 'ralph-compound.json');

function minimalAgentDag(overrides = {}) {
  return {
    $schemaVersion: DAG_SCHEMA_VERSION,
    name: 'mini',
    nodes: [
      {
        id: 'planner',
        type: 'agent',
        agentType: 'reader',
        model: 'planner',
        promptRef: 'ralph-compound/planner.md',
        user: 'hi {{input.prompt}}'
      },
      ...(overrides.extraNodes || [])
    ]
  };
}

test('parseAndValidateDag accepts the bundled ralph-compound template', async () => {
  const raw = await readFile(ralphTemplatePath, 'utf8');
  const dag = parseAndValidateDag(raw, { knownTools: new Set(['verifyRunCompletion']) });
  assert.equal(dag.$schemaVersion, DAG_SCHEMA_VERSION);
  assert.equal(dag.name, 'ralph-compound');
  assert.equal(dag.nodes.length, 2);
  assert.equal(dag.nodes[0].id, 'planner');
  assert.equal(dag.nodes[1].type, 'loop');
  assert.equal(dag.nodes[1].subgraph.length, 3);
});

test('validateDag rejects wrong schema version', () => {
  const dag = normalizeDag(minimalAgentDag());
  dag.$schemaVersion = 99;
  assert.throws(() => validateDag(dag), /\$schemaVersion/);
});

test('validateDag rejects missing nodes array', () => {
  assert.throws(() => validateDag({ $schemaVersion: 1, name: 'x', nodes: [] }), /nodes: must be a non-empty array/);
});

test('validateDag rejects duplicate sibling ids', () => {
  const dag = normalizeDag(minimalAgentDag());
  dag.nodes.push({
    id: 'planner',
    type: 'agent',
    agentType: 'reader',
    model: 'planner',
    promptRef: 'ralph-compound/planner.md'
  });
  assert.throws(() => validateDag(dag), /duplicate id "planner"/);
});

test('validateDag rejects inputs pointing to unknown sibling', () => {
  const dag = normalizeDag(minimalAgentDag());
  dag.nodes[0].inputs = ['ghost'];
  assert.throws(() => validateDag(dag), /references unknown sibling "ghost"/);
});

test('validateDag detects cycles', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'cyc',
    nodes: [
      { id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'x.md', inputs: ['b'] },
      { id: 'b', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'x.md', inputs: ['a'] }
    ]
  });
  assert.throws(() => validateDag(dag), /cycle detected/);
});

test('validateDag rejects parallel writers (single-cwd constraint)', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'two-writers',
    nodes: [
      { id: 'w1', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'a.md' },
      { id: 'w2', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'a.md' }
    ]
  });
  assert.throws(() => validateDag(dag), /parallel writer nodes/);
});

test('validateDag accepts serialized writers (one depends on the other)', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'two-writers-serial',
    nodes: [
      { id: 'w1', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'a.md' },
      { id: 'w2', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'a.md', inputs: ['w1'] }
    ]
  });
  assert.doesNotThrow(() => validateDag(dag));
});

test('validateDag accepts parallel readers (no shared-cwd write conflict)', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'two-readers',
    nodes: [
      { id: 'r1', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'a.md' },
      { id: 'r2', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'a.md' }
    ]
  });
  assert.doesNotThrow(() => validateDag(dag));
});

test('validateDag enforces promptRef shape', () => {
  const dag = normalizeDag(minimalAgentDag());
  dag.nodes[0].promptRef = '../escape.md';
  assert.throws(() => validateDag(dag), /promptRef/);
});

test('validateDag rejects unknown agentType', () => {
  const dag = normalizeDag(minimalAgentDag());
  dag.nodes[0].agentType = 'oracle';
  assert.throws(() => validateDag(dag), /agentType/);
});

test('validateDag rejects unknown tool when knownTools provided', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'has-tool',
    nodes: [{ id: 't', type: 'tool', tool: 'mystery' }]
  });
  assert.throws(() => validateDag(dag, { knownTools: new Set(['verifyRunCompletion']) }), /unknown tool "mystery"/);
});

test('validateDag accepts loop with valid subgraph', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'with-loop',
    nodes: [
      {
        id: 'lp',
        type: 'loop',
        maxIterations: 5,
        until: 'nodes.judge.json.ok == true',
        subgraph: [
          { id: 'worker', type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'w.md' },
          { id: 'judge', type: 'agent', agentType: 'judge', model: 'judge', promptRef: 'j.md', inputs: ['worker'] }
        ]
      }
    ]
  });
  assert.doesNotThrow(() => validateDag(dag));
});

test('validateDag rejects loop without subgraph', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'bad-loop',
    nodes: [{ id: 'lp', type: 'loop', maxIterations: 5 }]
  });
  assert.throws(() => validateDag(dag), /subgraph/);
});

test('validateDag rejects loop with non-positive maxIterations', () => {
  const dag = normalizeDag({
    $schemaVersion: 1,
    name: 'bad-loop',
    nodes: [{ id: 'lp', type: 'loop', maxIterations: 0, subgraph: [{ id: 'a', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'a.md' }] }]
  });
  assert.throws(() => validateDag(dag), /maxIterations/);
});

test('normalizeDag fills defaults non-destructively', () => {
  const input = { name: 'min', nodes: [{ id: 'a', agentType: 'reader', model: 'planner', promptRef: 'x.md' }] };
  const out = normalizeDag(input);
  assert.equal(out.$schemaVersion, DAG_SCHEMA_VERSION);
  assert.equal(out.concurrency, 2);
  assert.equal(out.nodes[0].type, 'agent');
  assert.deepEqual(out.nodes[0].inputs, []);
  // Source object untouched (deep clone).
  assert.equal(input.$schemaVersion, undefined);
});

test('iterateAllNodes visits subgraph nodes too', async () => {
  const raw = await readFile(ralphTemplatePath, 'utf8');
  const dag = parseAndValidateDag(raw, { knownTools: new Set(['verifyRunCompletion']) });
  const ids = [...iterateAllNodes(dag)].map(entry => entry.node.id);
  assert.deepEqual(ids, ['planner', 'review-loop', 'worker', 'judge', 'verify']);
});

test('nodeContractHash is stable across irrelevant field reordering', () => {
  const a = { id: 'x', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'a.md', user: 'hi', label: 'one' };
  const b = { label: 'two', user: 'hi', promptRef: 'a.md', model: 'planner', agentType: 'reader', type: 'agent', id: 'x' };
  assert.equal(nodeContractHash(a), nodeContractHash(b));
});
