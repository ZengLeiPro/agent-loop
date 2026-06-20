// Loop 节点执行器：按子图迭代，直到 until 表达式为真或达到 maxIterations。
//
// 每次迭代为子图产出绑定带 iteration 后缀的 nodeId（review-loop[1].worker 之类），
// 同时把「裸」nodeId（worker / judge / verify）写到 runtime.nodes 供 until 表达式与下游引用。
// loop 结束后，runtime.nodes 保留最后一轮的产出快照。

import { evalExpression } from '../expression.js';

export async function executeLoopNode({ node, runtime, runSubgraph, onEvent = () => {}, shouldStop }) {
  const iterVar = node.iterationVar || 'round';
  const start = node.iterationStart ?? 1;
  const max = node.maxIterations;
  let exitReason = 'max_iterations';
  let iterationsRan = 0;

  for (let i = 0; i < max; i += 1) {
    const iteration = start + i;
    const childRuntime = runtime.withLoop({ [iterVar]: iteration });
    onEvent({ type: 'loop_iteration_start', nodeId: node.id, iteration, iterVar });
    await runSubgraph({ subgraph: node.subgraph, runtime: childRuntime, iteration, parentLoopId: node.id });
    iterationsRan += 1;
    onEvent({ type: 'loop_iteration_end', nodeId: node.id, iteration });

    if (await shouldStop?.()) { exitReason = 'control_signal'; break; }

    if (node.until && node.until.trim()) {
      try {
        const stop = evalExpression(node.until, childRuntime.toEvalScope());
        if (stop) { exitReason = 'until_satisfied'; break; }
      } catch (error) {
        // until 表达式访问的字段可能尚未存在 → 视为 false，继续下一轮。
        if (error?.name === 'ExpressionError') continue;
        throw error;
      }
    }
  }

  return {
    text: '',
    json: { iterations: iterationsRan, exitReason },
    completedAt: new Date().toISOString()
  };
}
