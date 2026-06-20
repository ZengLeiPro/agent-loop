// DAG schema 定义与校验。
//
// 设计要点：
// - 单一 JSON schema 描述整个 run；runner 把它解析为节点图后调度。
// - 4 种节点类型：agent / loop / tool / gather。
// - agentType 三档：reader / writer / judge。writer 是唯一可以执行 Bash / 写共享文件的角色。
// - 校验同时检查拓扑（无环 + 同层 writer 互斥），让 schema 错误尽早暴露。
// - 表达式与模板字符串在执行期再校验；schema 校验只看结构。

import { ValidationError } from '../validation.js';

export const DAG_SCHEMA_VERSION = 1;
export const SUPPORTED_NODE_TYPES = new Set(['agent', 'loop', 'tool', 'gather']);
export const SUPPORTED_AGENT_TYPES = new Set(['reader', 'writer', 'judge']);
export const DEFAULT_CONCURRENCY = 2;
export const NODE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export const PROMPT_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.md$/;

const KNOWN_HOOKS = new Set(['captureGitEvidence', 'writeJudgeVerdictJson']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path, message) {
  throw new ValidationError(`DAG ${path}: ${message}`);
}

function ensureStringArray(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array of strings.');
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      fail(`${path}[${index}]`, 'must be a non-empty string.');
    }
  });
  return value;
}

function ensureUniqueIds(nodes, path) {
  const seen = new Set();
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node.id !== 'string' || !NODE_ID_PATTERN.test(node.id)) {
      fail(`${path}[${index}].id`, `must match ${NODE_ID_PATTERN}.`);
    }
    if (seen.has(node.id)) fail(`${path}[${index}].id`, `duplicate id "${node.id}" within siblings.`);
    seen.add(node.id);
  }
}

function ensureInputsResolve(nodes, path) {
  const ids = new Set(nodes.map(node => node.id));
  for (const [index, node] of nodes.entries()) {
    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
    for (const [inputIndex, inputId] of inputs.entries()) {
      if (!ids.has(inputId)) {
        fail(`${path}[${index}].inputs[${inputIndex}]`, `references unknown sibling "${inputId}".`);
      }
      if (inputId === node.id) {
        fail(`${path}[${index}].inputs[${inputIndex}]`, 'cannot reference itself.');
      }
    }
  }
}

function detectCycle(nodes, path) {
  const adj = new Map(nodes.map(node => [node.id, Array.isArray(node.inputs) ? node.inputs.slice() : []]));
  const state = new Map(nodes.map(node => [node.id, 'white']));

  function visit(id) {
    state.set(id, 'gray');
    for (const dep of adj.get(id) || []) {
      const color = state.get(dep);
      if (color === 'gray') fail(path, `cycle detected via "${id}" -> "${dep}".`);
      if (color === 'white') visit(dep);
    }
    state.set(id, 'black');
  }

  for (const node of nodes) {
    if (state.get(node.id) === 'white') visit(node.id);
  }
}

// 拓扑可达性：u 是否在 v 之前（即 u 是 v 的某条输入链上的祖先）。
function buildReachability(nodes) {
  const adj = new Map(nodes.map(node => [node.id, Array.isArray(node.inputs) ? node.inputs.slice() : []]));
  const ancestors = new Map(); // id -> Set of all transitive inputs

  function ancestorsOf(id) {
    if (ancestors.has(id)) return ancestors.get(id);
    const acc = new Set();
    for (const dep of adj.get(id) || []) {
      acc.add(dep);
      for (const upstream of ancestorsOf(dep)) acc.add(upstream);
    }
    ancestors.set(id, acc);
    return acc;
  }

  for (const node of nodes) ancestorsOf(node.id);
  return ancestors;
}

// 同层 writer 互斥：任意两个 writer 必须有依赖路径关系。
// 这条规则保证「同时只有一个 writer 能跑」，避免共享 cwd 文件写冲突。
function ensureWritersOrdered(nodes, path) {
  const writers = nodes.filter(node => node.type === 'agent' && node.agentType === 'writer');
  if (writers.length < 2) return;
  const ancestors = buildReachability(nodes);
  for (let i = 0; i < writers.length; i += 1) {
    for (let j = i + 1; j < writers.length; j += 1) {
      const a = writers[i].id;
      const b = writers[j].id;
      const aBeforeB = ancestors.get(b)?.has(a);
      const bBeforeA = ancestors.get(a)?.has(b);
      if (!aBeforeB && !bBeforeA) {
        fail(path, `parallel writer nodes "${a}" and "${b}" must be ordered via inputs (single shared cwd cannot host concurrent writers).`);
      }
    }
  }
}

function validateAgentNode(node, path) {
  if (!SUPPORTED_AGENT_TYPES.has(node.agentType)) {
    fail(`${path}.agentType`, `must be one of ${[...SUPPORTED_AGENT_TYPES].join(', ')}.`);
  }
  if (typeof node.model !== 'string' || !node.model.trim()) {
    fail(`${path}.model`, 'must be a non-empty string (model role key or literal model id).');
  }
  if (typeof node.promptRef !== 'string' || !PROMPT_REF_PATTERN.test(node.promptRef) || node.promptRef.includes('..')) {
    fail(`${path}.promptRef`, `must match ${PROMPT_REF_PATTERN} and not contain "..".`);
  }
  if (node.user !== undefined && typeof node.user !== 'string') {
    fail(`${path}.user`, 'must be a string template when present.');
  }
  if (node.allowedTools !== undefined) ensureStringArray(node.allowedTools, `${path}.allowedTools`);
  if (node.hooks !== undefined) {
    if (!isPlainObject(node.hooks)) fail(`${path}.hooks`, 'must be an object when present.');
    for (const key of Object.keys(node.hooks)) {
      if (!KNOWN_HOOKS.has(key)) fail(`${path}.hooks.${key}`, `unknown hook (known: ${[...KNOWN_HOOKS].join(', ')}).`);
      if (typeof node.hooks[key] !== 'boolean') fail(`${path}.hooks.${key}`, 'must be a boolean.');
    }
  }
}

function validateLoopNode(node, path, knownTools) {
  if (typeof node.maxIterations !== 'number' || !Number.isInteger(node.maxIterations) || node.maxIterations < 1) {
    fail(`${path}.maxIterations`, 'must be a positive integer.');
  }
  if (node.iterationVar !== undefined && (typeof node.iterationVar !== 'string' || !NODE_ID_PATTERN.test(node.iterationVar))) {
    fail(`${path}.iterationVar`, `must match ${NODE_ID_PATTERN} when present.`);
  }
  if (node.iterationStart !== undefined && (!Number.isInteger(node.iterationStart) || node.iterationStart < 0)) {
    fail(`${path}.iterationStart`, 'must be a non-negative integer when present.');
  }
  if (node.until !== undefined && typeof node.until !== 'string') {
    fail(`${path}.until`, 'must be a string expression when present.');
  }
  if (!Array.isArray(node.subgraph) || node.subgraph.length === 0) {
    fail(`${path}.subgraph`, 'must be a non-empty array of nodes.');
  }
  validateNodes(node.subgraph, `${path}.subgraph`, knownTools);
}

function validateToolNode(node, path, knownTools) {
  if (typeof node.tool !== 'string' || !node.tool.trim()) {
    fail(`${path}.tool`, 'must be a non-empty string.');
  }
  if (knownTools && knownTools.size > 0 && !knownTools.has(node.tool)) {
    fail(`${path}.tool`, `unknown tool "${node.tool}". Known tools: ${[...knownTools].join(', ')}.`);
  }
  if (node.args !== undefined && !isPlainObject(node.args)) {
    fail(`${path}.args`, 'must be a plain object when present.');
  }
}

function validateGatherNode(node, path) {
  if (node.combine !== undefined && !['first', 'all', 'last'].includes(node.combine)) {
    fail(`${path}.combine`, 'must be one of: first, all, last.');
  }
}

function validateNode(node, path, knownTools) {
  if (!isPlainObject(node)) fail(path, 'must be an object.');
  const type = node.type || 'agent';
  if (!SUPPORTED_NODE_TYPES.has(type)) {
    fail(`${path}.type`, `must be one of ${[...SUPPORTED_NODE_TYPES].join(', ')}.`);
  }
  if (node.inputs !== undefined) ensureStringArray(node.inputs, `${path}.inputs`);
  if (node.label !== undefined && typeof node.label !== 'string') {
    fail(`${path}.label`, 'must be a string when present.');
  }

  if (type === 'agent') validateAgentNode(node, path);
  if (type === 'loop') validateLoopNode(node, path, knownTools);
  if (type === 'tool') validateToolNode(node, path, knownTools);
  if (type === 'gather') validateGatherNode(node, path);
}

function validateNodes(nodes, path, knownTools) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail(path, 'must be a non-empty array.');
  }
  ensureUniqueIds(nodes, path);
  for (const [index, node] of nodes.entries()) {
    validateNode(node, `${path}[${index}]`, knownTools);
  }
  ensureInputsResolve(nodes, path);
  detectCycle(nodes, path);
  ensureWritersOrdered(nodes, path);
}

export function normalizeDag(dag) {
  // Apply defaults non-destructively. Returns a deep-cloned, defaulted copy.
  if (!isPlainObject(dag)) throw new ValidationError('DAG: payload must be an object.');
  const clone = structuredClone(dag);
  if (clone.$schemaVersion === undefined) clone.$schemaVersion = DAG_SCHEMA_VERSION;
  if (clone.concurrency === undefined) clone.concurrency = DEFAULT_CONCURRENCY;
  if (!Array.isArray(clone.nodes)) clone.nodes = [];

  function normalizeNode(node) {
    if (!isPlainObject(node)) return node;
    if (node.type === undefined) node.type = 'agent';
    if (!Array.isArray(node.inputs)) node.inputs = [];
    if (node.type === 'agent' && node.hooks === undefined) node.hooks = {};
    if (node.type === 'loop') {
      if (node.iterationVar === undefined) node.iterationVar = 'round';
      if (node.iterationStart === undefined) node.iterationStart = 1;
      if (Array.isArray(node.subgraph)) node.subgraph.forEach(normalizeNode);
    }
    if (node.type === 'tool' && node.args === undefined) node.args = {};
    if (node.type === 'gather' && node.combine === undefined) node.combine = 'all';
  }

  clone.nodes.forEach(normalizeNode);
  return clone;
}

export function validateDag(dag, { knownTools = new Set() } = {}) {
  if (!isPlainObject(dag)) throw new ValidationError('DAG: payload must be an object.');
  if (dag.$schemaVersion !== DAG_SCHEMA_VERSION) {
    throw new ValidationError(`DAG.$schemaVersion must be ${DAG_SCHEMA_VERSION}.`);
  }
  if (typeof dag.name !== 'string' || !dag.name.trim()) {
    throw new ValidationError('DAG.name must be a non-empty string.');
  }
  if (dag.description !== undefined && typeof dag.description !== 'string') {
    throw new ValidationError('DAG.description must be a string when present.');
  }
  if (dag.concurrency !== undefined && (!Number.isInteger(dag.concurrency) || dag.concurrency < 1)) {
    throw new ValidationError('DAG.concurrency must be a positive integer.');
  }
  validateNodes(dag.nodes, 'nodes', knownTools);
  return dag;
}

export function parseAndValidateDag(rawOrObject, options) {
  const dag = typeof rawOrObject === 'string' ? JSON.parse(rawOrObject) : rawOrObject;
  const normalized = normalizeDag(dag);
  validateDag(normalized, options);
  return normalized;
}

// Iterate over every node (including nested subgraph nodes) for inspection.
export function* iterateAllNodes(dag) {
  function* walk(nodes, prefix) {
    for (const node of nodes) {
      yield { node, path: prefix.concat(node.id) };
      if (node.type === 'loop' && Array.isArray(node.subgraph)) {
        yield* walk(node.subgraph, prefix.concat(node.id));
      }
    }
  }
  yield* walk(dag.nodes, []);
}

// Stable hash of a node's contract for cache lookups. Excludes label / display-only fields.
export function nodeContractHash(node) {
  const keys = ['id', 'type', 'agentType', 'model', 'promptRef', 'user', 'allowedTools', 'inputs', 'hooks', 'tool', 'args', 'combine', 'maxIterations', 'iterationVar', 'iterationStart', 'until'];
  const pick = {};
  for (const key of keys) if (node[key] !== undefined) pick[key] = node[key];
  return JSON.stringify(pick);
}
