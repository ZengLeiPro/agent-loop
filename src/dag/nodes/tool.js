// Tool 节点执行器：调用注册的 JS 工具，零 LLM。

import { getTool } from '../tools.js';
import { renderObjectTemplates } from '../template.js';

export async function executeToolNode({ node, cwd, runtime, iteration = 0, onEvent = () => {} }) {
  const tool = getTool(node.tool);
  if (!tool) throw new Error(`DAG tool "${node.tool}" is not registered.`);

  const args = renderObjectTemplates(node.args || {}, runtime.toEvalScope());
  onEvent({ type: 'tool_start', nodeId: node.id, iteration, tool: node.tool, args });
  const json = await tool(args, { cwd, runtime, publishEvent: event => onEvent({ ...event, nodeId: node.id, iteration }) });
  onEvent({ type: 'tool_end', nodeId: node.id, iteration, tool: node.tool });

  return {
    text: '',
    json,
    completedAt: new Date().toISOString()
  };
}
