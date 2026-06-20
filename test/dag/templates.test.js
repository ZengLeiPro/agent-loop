import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listTemplates, loadTemplate, templatePath } from '../../src/dag/templates.js';

test('listTemplates includes the bundled ralph-compound template', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-templates-list-'));
  const items = await listTemplates(cwd);
  const names = items.map(item => item.name);
  assert.ok(names.includes('ralph-compound'), `expected ralph-compound; got ${names.join(', ')}`);
  const ralph = items.find(item => item.name === 'ralph-compound');
  assert.equal(ralph.source, 'bundled');
});

test('loadTemplate returns a validated DAG for ralph-compound', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-templates-load-'));
  const { name, dag } = await loadTemplate('ralph-compound', { cwd, knownTools: new Set(['verifyRunCompletion']) });
  assert.equal(name, 'ralph-compound');
  assert.equal(dag.nodes[0].id, 'planner');
});

test('user-templates dir shadows bundled when present', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-templates-user-'));
  const userDir = join(cwd, '.agent-loop', 'templates');
  await mkdir(userDir, { recursive: true });
  const override = {
    $schemaVersion: 1,
    name: 'ralph-compound',
    description: 'user override',
    nodes: [
      { id: 'planner', type: 'agent', agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md' }
    ]
  };
  await writeFile(join(userDir, 'ralph-compound.json'), `${JSON.stringify(override, null, 2)}\n`, 'utf8');
  const items = await listTemplates(cwd);
  const ralph = items.find(item => item.name === 'ralph-compound');
  assert.equal(ralph.source, 'user');
  assert.equal(templatePath(cwd, 'ralph-compound'), join(userDir, 'ralph-compound.json'));
  const { dag } = await loadTemplate('ralph-compound', { cwd, knownTools: new Set(['verifyRunCompletion']) });
  assert.equal(dag.description, 'user override');
  assert.equal(dag.nodes.length, 1);
});

test('templatePath throws for unknown templates', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-templates-missing-'));
  assert.throws(() => templatePath(cwd, 'nonexistent'), /Template "nonexistent" not found/);
});

test('templatePath rejects invalid names', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-templates-bad-name-'));
  assert.throws(() => templatePath(cwd, '../etc/passwd'), /Invalid template name/);
});
