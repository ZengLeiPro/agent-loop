import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRun } from '../src/core.js';
import { verifyRunCompletion } from '../src/runner.js';

async function createCompletionFixture({ progress, prd, judge }) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-test-'));
  const stateDir = join(cwd, '.agent-loop');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'progress.txt'), progress, 'utf8');
  await writeFile(join(stateDir, 'prd.json'), `${JSON.stringify(prd, null, 2)}\n`, 'utf8');
  await writeFile(join(stateDir, 'judge-1.md'), judge, 'utf8');
  return cwd;
}

test('verifyRunCompletion accepts sentinel only on the final progress line', async () => {
  const cwd = await createCompletionFixture({
    progress: '## Round 1\nDone\n<promise>COMPLETE</promise>\n',
    prd: { userStories: [{ id: 's1', passes: true }] },
    judge: 'VERDICT: PASS\n'
  });

  assert.deepEqual(await verifyRunCompletion(cwd, 1), {
    sentinelOk: true,
    passCountOk: true,
    judgeOk: true,
    judgeSource: 'markdown',
    complete: true
  });
});

test('verifyRunCompletion rejects historical sentinel that is not the final progress line', async () => {
  const cwd = await createCompletionFixture({
    progress: '## Round 1\n<promise>COMPLETE</promise>\nMore work remains\n',
    prd: { userStories: [{ id: 's1', passes: true }] },
    judge: 'VERDICT: PASS\n'
  });

  assert.deepEqual(await verifyRunCompletion(cwd, 1), {
    sentinelOk: false,
    passCountOk: true,
    judgeOk: true,
    judgeSource: 'markdown',
    complete: false
  });
});

test('verifyRunCompletion requires non-empty PRD stories and Judge PASS', async () => {
  const cwd = await createCompletionFixture({
    progress: '<promise>COMPLETE</promise>\n',
    prd: { userStories: [] },
    judge: 'VERDICT: FAIL\n'
  });

  assert.deepEqual(await verifyRunCompletion(cwd, 1), {
    sentinelOk: true,
    passCountOk: false,
    judgeOk: false,
    judgeSource: 'markdown',
    complete: false
  });
});

test('verifyRunCompletion prefers structured judge verdict JSON over markdown', async () => {
  const cwd = await createCompletionFixture({
    progress: '<promise>COMPLETE</promise>\n',
    prd: { userStories: [{ id: 's1', passes: true }] },
    judge: 'VERDICT: FAIL\n'
  });
  await writeFile(join(cwd, '.agent-loop', 'judge-1.json'), `${JSON.stringify({ verdict: 'PASS' }, null, 2)}\n`, 'utf8');

  assert.deepEqual(await verifyRunCompletion(cwd, 1), {
    sentinelOk: true,
    passCountOk: true,
    judgeOk: true,
    judgeSource: 'json',
    complete: true
  });
});

test('startRun does not create a permanent pending planner timeline placeholder for real runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-real-run-phases-'));
  const run = await startRun({ cwd, prompt: 'real run should wait without a pending phase', dryRun: false });

  assert.equal(run.status, 'waiting-for-agent-adapter');
  assert.deepEqual(run.phases, []);
});

test('verifyRunCompletion treats invalid PRD JSON as an incomplete run instead of throwing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-loop-invalid-prd-completion-'));
  const stateDir = join(cwd, '.agent-loop');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'progress.txt'), '<promise>COMPLETE</promise>\n', 'utf8');
  await writeFile(join(stateDir, 'prd.json'), '{invalid', 'utf8');
  await writeFile(join(stateDir, 'judge-1.md'), 'VERDICT: PASS\n', 'utf8');

  assert.deepEqual(await verifyRunCompletion(cwd, 1), {
    sentinelOk: true,
    passCountOk: false,
    judgeOk: true,
    judgeSource: 'markdown',
    complete: false
  });
});
