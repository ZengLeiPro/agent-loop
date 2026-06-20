import test from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression, ExpressionError } from '../../src/dag/expression.js';

const scope = {
  input: { prompt: 'hi' },
  nodes: {
    verify: { json: { complete: true, round: 3 } },
    judge: { json: { verdict: 'PASS' } }
  },
  loop: { round: 3 }
};

test('evalExpression supports boolean literals', () => {
  assert.equal(evalExpression('true', scope), true);
  assert.equal(evalExpression('false', scope), false);
});

test('evalExpression supports comparison and AND/OR', () => {
  assert.equal(evalExpression('loop.round == 3', scope), true);
  assert.equal(evalExpression('loop.round > 5', scope), false);
  assert.equal(evalExpression('loop.round == 3 && nodes.judge.json.verdict == "PASS"', scope), true);
  assert.equal(evalExpression('loop.round == 1 || nodes.judge.json.verdict == "PASS"', scope), true);
});

test('evalExpression supports negation and parentheses', () => {
  assert.equal(evalExpression('!(loop.round == 1)', scope), true);
  assert.equal(evalExpression('!(nodes.judge.json.verdict == "PASS")', scope), false);
});

test('evalExpression returns false on missing paths instead of throwing', () => {
  assert.equal(evalExpression('nodes.ghost.json.complete == true', scope), false);
});

test('evalExpression throws ExpressionError on syntax errors', () => {
  assert.throws(() => evalExpression('loop.round ==', scope), ExpressionError);
  assert.throws(() => evalExpression('foo bar', scope), ExpressionError);
});

test('evalExpression understands string literals with both quote styles', () => {
  assert.equal(evalExpression(`nodes.judge.json.verdict == 'PASS'`, scope), true);
  assert.equal(evalExpression(`nodes.judge.json.verdict == "PASS"`, scope), true);
});

test('evalExpression treats empty string as false (no-op)', () => {
  assert.equal(evalExpression('', scope), false);
  assert.equal(evalExpression('   ', scope), false);
});
