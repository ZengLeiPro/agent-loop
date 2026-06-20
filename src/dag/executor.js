// DAG executor —— 拓扑执行 + 并发信号量 + 取消/暂停传播 + 节点状态写盘。

import { join } from 'node:path';
import { ClaudeAgentAdapter } from '../claude-agent-adapter.js';
import { stateDir, writeRun } from '../core.js';
import { assertCurrentRun, clearRunLock, touchRunLock } from '../run-lock.js';
import { clearControl, shouldStopAfterPhase } from '../control.js';
import { knownToolNames } from './tools.js';
import { parseAndValidateDag, iterateAllNodes } from './schema.js';
import { RuntimeContext } from './runtime-context.js';
import { writeNodeOutput } from './output-store.js';
import { derivePhasesFromNodes } from './migration.js';
import { executeAgentNode } from './nodes/agent.js';
import { executeToolNode } from './nodes/tool.js';
import { executeGatherNode } from './nodes/gather.js';
import { executeLoopNode } from './nodes/loop.js';
import { buildCacheKey, readCacheEntry, writeCacheEntry } from './cache.js';

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) { this.active += 1; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function ralphLegacyFor(nodeId, iteration, parentLoopId) {
  // Map common ralph DAG node ids to legacy phase {role, round} for backward-compat phases[] view.
  if (nodeId === 'planner' && !parentLoopId) return { role: 'planner', round: 0, phaseId: 'plan' };
  if (parentLoopId === 'review-loop' && nodeId === 'worker') return { role: 'worker', round: iteration, phaseId: `worker-${iteration}` };
  if (parentLoopId === 'review-loop' && nodeId === 'judge') return { role: 'judge', round: iteration, phaseId: `judge-${iteration}` };
  return null;
}

function nodeRecordId(node, iteration, parentLoopId) {
  if (parentLoopId) return `${parentLoopId}[${iteration}].${node.id}`;
  return node.id;
}

export class DagExecutor {
  constructor({
    dag,
    cwd,
    run,
    input = {},
    models = {},
    adapterDefaults = {},
    toolOverrides = {},
    systemPromptResolver,
    publishEvent = async () => {},
    concurrency,
    runOnly = null,
    adapterFactory = null
  }) {
    this.runOnly = Array.isArray(runOnly) && runOnly.length ? new Set(runOnly) : null;
    this.adapterFactory = adapterFactory;
    this.dag = parseAndValidateDag(dag, { knownTools: knownToolNames() });
    this.cwd = cwd;
    this.run = run;
    this.input = input;
    this.models = models;
    this.adapterDefaults = adapterDefaults;
    this.toolOverrides = toolOverrides;
    this.systemPromptResolver = systemPromptResolver;
    this.publishEvent = publishEvent;
    this.semaphore = new Semaphore(concurrency ?? this.dag.concurrency ?? 1);
    this.cancelled = false;
    this.writeChain = Promise.resolve();
  }

  async #emit(event) {
    try { await this.publishEvent(event); } catch { /* ignore subscriber errors */ }
  }

  async #upsertNodeRecord(record) {
    // Serialize all run.json writes through writeChain — multiple concurrent nodes
    // would otherwise race on the temp-file + rename used by core.writeRun.
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      if (!Array.isArray(this.run.nodes)) this.run.nodes = [];
      const index = this.run.nodes.findIndex(entry => entry.id === record.id);
      if (index === -1) this.run.nodes.push(record);
      else this.run.nodes[index] = { ...this.run.nodes[index], ...record };
      this.run.phases = derivePhasesFromNodes(this.run.nodes);
      this.run.updatedAt = new Date().toISOString();
      await assertCurrentRun(this.cwd, this.run.id);
      await writeRun(this.run, this.cwd);
      await touchRunLock(this.cwd, { runId: this.run.id, nodeId: record.id });
    });
    await this.writeChain;
  }

  async #runOneNode({ node, runtime, iteration, parentLoopId }) {
    if (this.cancelled) throw new Error('DAG execution cancelled.');
    // loop / gather nodes are coordinators (no LLM/tool call), they must not consume a concurrency slot
    // or they would deadlock against their own subgraph children.
    const consumesConcurrency = node.type === 'agent' || node.type === 'tool';
    if (consumesConcurrency) await this.semaphore.acquire();
    const recordId = nodeRecordId(node, iteration, parentLoopId);
    const retryConfig = node.retries || {};
    const maxRetries = Number.isInteger(retryConfig.max) ? retryConfig.max : 0;
    const backoffBase = Number.isInteger(retryConfig.backoffMs) ? retryConfig.backoffMs : 1000;
    let attempt = 0;
    const legacy = ralphLegacyFor(node.id, iteration, parentLoopId);
    const startedAt = new Date().toISOString();
    await this.#upsertNodeRecord({
      id: recordId,
      nodeRef: node.id,
      type: node.type,
      iteration,
      parentLoopId,
      status: 'running',
      startedAt,
      ...(legacy ? { legacyRole: legacy.role, legacyRound: legacy.round, legacyPhaseId: legacy.phaseId } : {})
    });
    await this.#emit({ type: 'node_start', runId: this.run.id, nodeId: recordId, nodeRef: node.id, nodeType: node.type, iteration, parentLoopId });

    // Retry loop. On failure within budget: backoff + retry without re-cache-lookup.
    // Final failure: record failed + rethrow. Outer try/finally ensures semaphore release.
    try {
    // eslint-disable-next-line no-unmodified-loop-condition
    while (true) {
    try {
      // Cache lookup (agent / tool / gather only — loop output is just iteration stats).
      let upstreamSnapshot = {};
      if (node.cache?.enabled && node.type !== 'loop') {
        for (const inputId of node.inputs || []) {
          const upstream = runtime.getNode(inputId);
          if (upstream) upstreamSnapshot[inputId] = upstream;
        }
        const cacheKey = buildCacheKey(node, upstreamSnapshot);
        const cached = await readCacheEntry(this.cwd, cacheKey);
        if (cached?.value) {
          await this.#emit({ type: 'node_cache_hit', runId: this.run.id, nodeId: recordId, nodeRef: node.id, cacheKey });
          const output = cached.value;
          const outputPath = await writeNodeOutput(this.cwd, recordId, iteration, output);
          runtime.recordNode(node.id, output);
          runtime.recordNode(recordId, output);
          await this.#upsertNodeRecord({
            id: recordId,
            status: 'completed',
            completedAt: new Date().toISOString(),
            cacheHit: true,
            outputPath
          });
          await this.#emit({ type: 'node_end', runId: this.run.id, nodeId: recordId, nodeRef: node.id, status: 'completed', iteration, cacheHit: true });
          return output;
        }
      }

      let output;
      if (node.type === 'agent') {
        output = await executeAgentNode({
          node,
          cwd: this.cwd,
          runtime,
          iteration,
          models: this.models,
          adapterDefaults: this.adapterDefaults,
          toolOverrides: this.toolOverrides,
          systemPromptResolver: this.systemPromptResolver,
          adapterFactory: this.adapterFactory,
          onEvent: event => this.#emit({ ...event, type: event.type || 'agent_event', runId: this.run.id, recordId })
        });
      } else if (node.type === 'tool') {
        output = await executeToolNode({
          node,
          cwd: this.cwd,
          runtime,
          iteration,
          onEvent: event => this.#emit({ ...event, runId: this.run.id, recordId })
        });
      } else if (node.type === 'gather') {
        output = await executeGatherNode({ node, runtime });
      } else if (node.type === 'loop') {
        output = await executeLoopNode({
          node,
          runtime,
          runSubgraph: async ({ subgraph, runtime: childRuntime, iteration: childIteration, parentLoopId: childLoopId }) =>
            this.#runSubgraph({ nodes: subgraph, runtime: childRuntime, iteration: childIteration, parentLoopId: childLoopId }),
          onEvent: event => this.#emit({ ...event, runId: this.run.id, recordId }),
          shouldStop: async () => Boolean(await shouldStopAfterPhase(this.cwd)) || this.cancelled
        });
      } else {
        throw new Error(`Unknown DAG node type "${node.type}".`);
      }

      // Persist output to .agent-loop/nodes/<recordId>/<iteration>.json and runtime cache.
      const outputPath = await writeNodeOutput(this.cwd, recordId, iteration, output);
      // Also bind by both recordId (unique across loop iterations) and node.id (handy for downstream / until exprs).
      runtime.recordNode(node.id, output);
      runtime.recordNode(recordId, output);

      // Cache write (after success).
      if (node.cache?.enabled && node.type !== 'loop') {
        const cacheKey = buildCacheKey(node, upstreamSnapshot);
        await writeCacheEntry(this.cwd, cacheKey, output);
      }

      const completedAt = new Date().toISOString();
      await this.#upsertNodeRecord({
        id: recordId,
        status: 'completed',
        completedAt,
        sessionId: output.sessionId,
        totalCostUsd: output.totalCostUsd,
        outputPath,
        gitBefore: output.gitBefore,
        gitAfter: output.gitAfter
      });
      await this.#emit({ type: 'node_end', runId: this.run.id, nodeId: recordId, nodeRef: node.id, status: 'completed', iteration, attempt });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < maxRetries) {
        attempt += 1;
        const backoff = backoffBase * Math.pow(2, attempt - 1);
        await this.#emit({ type: 'node_retry', runId: this.run.id, nodeId: recordId, nodeRef: node.id, attempt, maxRetries, backoffMs: backoff, error: message });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      await this.#upsertNodeRecord({
        id: recordId,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: message,
        attempts: attempt + 1
      });
      await this.#emit({ type: 'node_end', runId: this.run.id, nodeId: recordId, nodeRef: node.id, status: 'failed', iteration, error: message, attempts: attempt + 1 });
      throw error;
    }
    }
    } finally {
      if (consumesConcurrency) this.semaphore.release();
    }
  }

  async #runSubgraph({ nodes, runtime, iteration = 0, parentLoopId = null }) {
    // Each node returns a promise; inputs are awaited before scheduling.
    const promises = new Map();
    const errors = [];

    const startNode = async node => {
      try {
        for (const inputId of node.inputs || []) {
          const prerequisite = promises.get(inputId);
          if (prerequisite) await prerequisite;
        }
        await this.#runOneNode({ node, runtime, iteration, parentLoopId });
      } catch (error) {
        errors.push(error);
        throw error;
      }
    };

    for (const node of nodes) promises.set(node.id, startNode(node));

    // Wait for all; collect first error.
    const settled = await Promise.allSettled(promises.values());
    const rejected = settled.find(item => item.status === 'rejected');
    if (rejected) throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
  }

  cancel() { this.cancelled = true; }

  async execute() {
    const runtime = new RuntimeContext({ cwd: this.cwd, input: this.input });
    const topLevel = this.runOnly
      ? this.dag.nodes.filter(node => this.runOnly.has(node.id))
      : this.dag.nodes;
    try {
      await this.#runSubgraph({ nodes: topLevel, runtime });
      return runtime;
    } finally {
      // Lock cleanup is the caller's responsibility (matches old runner.js).
    }
  }
}

// Convenience helpers exposed to callers.
export function dagNodeIds(dag) {
  return [...iterateAllNodes(dag)].map(entry => entry.node.id);
}

export { knownToolNames } from './tools.js';
