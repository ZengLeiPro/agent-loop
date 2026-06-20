// RuntimeContext —— 一个 DAG run 的执行期上下文。
//
// 三组数据：
// - input: 来自启动方（CLI prompt / Web /api/run body），整 run 不变；
// - nodes: nodeId → 最新产出 {text, json, sessionId, totalCostUsd, ...}；
// - loop:  当前所在 loop 的迭代变量（嵌套 loop 时合并父作用域）。
//
// 子作用域用 withLoop()：浅克隆 nodes，新增 loop 变量，从父继承。
// 子作用域内对 nodes 的写入会回写到父，保证下游节点能看到上游产出。

export class RuntimeContext {
  constructor({ cwd, input = {}, parent = null, loopVars = {} } = {}) {
    this.cwd = cwd;
    this.input = input;
    this.parent = parent;
    this.nodes = parent ? parent.nodes : {};
    this.loop = { ...(parent?.loop || {}), ...loopVars };
  }

  recordNode(nodeId, output) {
    this.nodes[nodeId] = output;
  }

  hasNode(nodeId) {
    return Object.hasOwn(this.nodes, nodeId);
  }

  getNode(nodeId) {
    return this.nodes[nodeId];
  }

  withLoop(loopVars) {
    return new RuntimeContext({ cwd: this.cwd, input: this.input, parent: this, loopVars });
  }

  toEvalScope() {
    return { input: this.input, nodes: this.nodes, loop: this.loop };
  }
}
