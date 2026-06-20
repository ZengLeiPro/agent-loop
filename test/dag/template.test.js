import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, renderObjectTemplates, TemplateError } from '../../src/dag/template.js';

const scope = {
  input: { prompt: 'hello world' },
  nodes: {
    planner: {
      text: 'plan output',
      json: { userStories: [{ id: 's1', passes: false }, { id: 's2', passes: true }] }
    }
  },
  loop: { round: 3 }
};

test('renderTemplate resolves top-level fields', () => {
  assert.equal(renderTemplate('hi {{input.prompt}}', scope), 'hi hello world');
});

test('renderTemplate resolves nested + array index', () => {
  assert.equal(renderTemplate('first={{nodes.planner.json.userStories[0].id}}', scope), 'first=s1');
});

test('renderTemplate stringifies non-string values', () => {
  assert.equal(renderTemplate('round={{loop.round}}', scope), 'round=3');
});

test('renderTemplate fails clearly on missing path', () => {
  assert.throws(() => renderTemplate('{{nodes.ghost.text}}', scope), TemplateError);
});

test('renderTemplate ignores literal strings without placeholders', () => {
  assert.equal(renderTemplate('static literal', scope), 'static literal');
});

test('renderObjectTemplates recurses through nested objects', () => {
  const args = { round: '{{loop.round}}', meta: { id: 'r{{loop.round}}', flag: true } };
  assert.deepEqual(renderObjectTemplates(args, scope), { round: '3', meta: { id: 'r3', flag: true } });
});

test('renderObjectTemplates passes arrays through', () => {
  const args = ['r{{loop.round}}', { x: '{{input.prompt}}' }];
  assert.deepEqual(renderObjectTemplates(args, scope), ['r3', { x: 'hello world' }]);
});
