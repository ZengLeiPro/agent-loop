// Gather 节点执行器：聚合上游 inputs 的产出为单一对象。
//
// combine 语义：
// - 'all'   → { [inputId]: output, ... } （默认）
// - 'first' → 首个 input 的 output
// - 'last'  → 末个 input 的 output

export async function executeGatherNode({ node, runtime }) {
  const inputs = node.inputs || [];
  const collected = {};
  for (const id of inputs) collected[id] = runtime.getNode(id);

  let json;
  if (node.combine === 'first') json = collected[inputs[0]];
  else if (node.combine === 'last') json = collected[inputs.at(-1)];
  else json = collected;

  return {
    text: '',
    json,
    completedAt: new Date().toISOString()
  };
}
