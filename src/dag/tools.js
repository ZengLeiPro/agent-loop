// DAG tool 节点的内置注册表。
//
// Tool 是 JS 函数，零 LLM 调用，用来沉淀「确定性逻辑」——校验、汇总、文件操作、shell 命令封装。
// 每个工具签名：(args, ctx) => Promise<output>，其中 output 是 JSON-serializable。
// ctx 包含 cwd / runtime / publishEvent，工具可以读 runtime.nodes 拿到上游产出。

import { verifyRunCompletion } from '../verify-completion.js';

export const BUILTIN_TOOLS = {
  // ralph 完成校验：sentinel + PRD passes + Judge verdict。
  verifyRunCompletion: async (args, { cwd, runtime }) => {
    const round = Number(args?.round ?? runtime.loop?.round ?? 0);
    const result = await verifyRunCompletion(cwd, round);
    return { ...result, round };
  },

  // identity：返回输入参数本身；调试 / 模板拼接产出。
  echo: async args => ({ ...args }),

  // sleep：纯延时（毫秒），常用于测试 / 限速。
  sleep: async args => {
    const ms = Math.max(0, Math.min(60000, Number(args?.ms || 0)));
    await new Promise(resolve => setTimeout(resolve, ms));
    return { slept: ms };
  }
};

export function knownToolNames() {
  return new Set(Object.keys(BUILTIN_TOOLS));
}

export function getTool(name) {
  return BUILTIN_TOOLS[name];
}
