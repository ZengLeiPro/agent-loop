import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRun, startRun } from '../../src/core.js';
import { migrateRun, derivePhasesFromNodes, RUN_SCHEMA_VERSION } from '../../src/dag/migration.js';

test('migrateRun adds schemaVersion and nodes to legacy run.json', () => {
  const legacy = {
    id: 'run_old',
    status: 'completed',
    prompt: 'legacy',
    phases: [
      { id: 'plan', role: 'planner', status: 'completed', startedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'worker-1', role: 'worker', round: 1, status: 'completed', sessionId: 'sess_abc' },
      { id: 'judge-1', role: 'judge', round: 1, status: 'completed' }
    ]
  };
  const migrated = migrateRun(legacy);
  assert.equal(migrated.schemaVersion, RUN_SCHEMA_VERSION);
  assert.equal(migrated.template, 'ralph-compound');
  assert.equal(migrated.nodes.length, 3);
  assert.equal(migrated.nodes[0].id, 'planner');
  assert.equal(migrated.nodes[1].id, 'review-loop[1].worker');
  assert.equal(migrated.nodes[1].sessionId, 'sess_abc');
  // Phases untouched, still readable by old code paths.
  assert.equal(migrated.phases.length, 3);
});

test('migrateRun is idempotent', () => {
  const legacy = { phases: [], status: 'initialized' };
  const once = migrateRun(legacy);
  const twice = migrateRun(once);
  assert.equal(twice.schemaVersion, RUN_SCHEMA_VERSION);
  assert.equal(twice.nodes.length, 0);
  assert.equal(twice, twice); // same shape; no double-wrap
});

test('derivePhasesFromNodes reconstructs legacy phases[] from nodes[]', () => {
  const nodes = [
    { id: 'planner', legacyRole: 'planner', legacyRound: 0, legacyPhaseId: 'plan', status: 'completed', startedAt: 't1', completedAt: 't2' },
    { id: 'review-loop[1].worker', legacyRole: 'worker', legacyRound: 1, status: 'running' }
  ];
  const phases = derivePhasesFromNodes(nodes);
  assert.equal(phases.length, 2);
  assert.equal(phases[0].id, 'plan');
  assert.equal(phases[0].role, 'planner');
  assert.equal(phases[1].id, 'worker-1');
  assert.equal(phases[1].round, 1);
});

test('startRun + readRun roundtrips with schemaVersion 2 and nodes[]', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-migrate-startrun-'));
  await startRun({ cwd, prompt: 'verify shape', dryRun: false });
  const run = await readRun(cwd);
  assert.equal(run.schemaVersion, RUN_SCHEMA_VERSION);
  assert.equal(run.template, 'ralph-compound');
  assert.deepEqual(run.nodes, []);
  assert.deepEqual(run.phases, []);
});

test('readRun migrates legacy run.json on disk transparently', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-migrate-legacy-'));
  const stateDir = join(cwd, '.agent-loop');
  await mkdir(stateDir, { recursive: true });
  const legacy = {
    id: 'run_legacy',
    status: 'completed',
    prompt: 'legacy on disk',
    phases: [
      { id: 'plan', role: 'planner', status: 'completed' },
      { id: 'worker-1', role: 'worker', round: 1, status: 'completed' }
    ]
  };
  await writeFile(join(stateDir, 'run.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const run = await readRun(cwd);
  assert.equal(run.schemaVersion, RUN_SCHEMA_VERSION);
  assert.equal(run.nodes.length, 2);
  assert.equal(run.nodes[0].id, 'planner');
});
