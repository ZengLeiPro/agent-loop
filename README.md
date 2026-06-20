# agent-loop

`agent-loop` 是一个独立、本地优先的 **DAG 驱动 Agent 编排** 项目，后续计划拆分为独立的 GitHub 仓库。它将一个简单的 CLI 与轻量级 Web UI 打包在一起，不依赖父级应用。

## 目标

- 将项目完整地自包含在当前目录中。
- 支持从 macOS 上的 Git checkout 本地运行。
- **通用 DAG 编排引擎**：节点（agent / loop / tool / gather）+ 依赖边，schema-validated；ralph-compound（Planner → Worker → Judge 循环）只是其中一个内置模板。
- 将目标仓库的项目本地状态写入 `.agent-loop/`（包含 `nodes/<id>/<iter>.json` 每节点产出 + `cache/` 节点缓存 + `templates/` 用户模板）。
- 内置 Web UI：DAG 监控（节点列表 + 状态色 + 详情）、可拖拽 DAG 编辑器（纯 SVG，零第三方依赖）。

## DAG 编排核心概念

| 概念 | 说明 |
|------|------|
| **模板**（template） | 一个 JSON 文件描述完整 DAG，schemaVersion=1。内置：`ralph-compound` / `parallel-review` / `map-reduce-refactor` / `meta-planner`。用户模板放 `.agent-loop/templates/<name>.json` 会覆盖同名内置模板。 |
| **节点类型** | `agent`（调 Claude SDK）/ `loop`（带 until 表达式的子图循环）/ `tool`（注册的 JS 工具，零 LLM）/ `gather`（聚合上游产出）。 |
| **agentType** | `reader`（只读 + 写工件）/ `writer`（含 Bash，唯一能改工程代码的角色，**同层 writer 必须串联**）/ `judge`（与 reader 工具集相同，语义为审计）。 |
| **模板字符串** | `{{input.prompt}}` / `{{nodes.<id>.text}}` / `{{nodes.<id>.json.userStories[0].id}}` / `{{loop.<var>}}`。极简成员/索引访问，不接 JS。 |
| **until 表达式** | loop 节点退出条件，例：`nodes.judge.json.verdict == 'PASS' && nodes.verify.json.complete == true`。支持 `==/!=/<=/>=/<>/&&/!/||/()`。 |
| **retries** | 节点级 `{ max, backoffMs }`，失败自动指数退避重试。 |
| **cache** | `{ enabled: true }` 时，(节点契约 + 上游产出) 命中时跳过执行。 |
| **plannerOnly** | 启动时只跑顶层 `planner` 节点，停在 `waiting-for-review` 等人工审核 spec/PRD 后 resume。 |

## 当前状态

项目已经从早期脚手架推进为一个可观察、可审计的本地 Agent Loop 控制台：

- 依赖较少的 Node.js CLI；
- 本地 HTTP 服务器与内置静态 Web UI；
- 本地运行状态创建；
- 内置 Ralph Compound 风格模板与提示语占位文件；
- 初始 `@anthropic-ai/claude-agent-sdk` 适配器；
- Planner → Worker → Judge runner 循环；
- 基于 sentinel、PRD pass 计数和 Judge verdict 的完成校验；
- 后台 Web job manager，让真实运行从 `/api/run` 长请求拆为可轮询/可观察的后台任务；
- `.agent-loop/events.ndjson` 事件流和 `/api/events` SSE/JSON backlog；
- Git preflight、逐轮 Worker diff/evidence 归档、结构化 Judge verdict JSON；
- Web Autopilot 等级、run controls、Live events、Quality Gate、Changes/Evidence 和 PRD stories summary。

重要限制：

- 拆分或 checkout 项目后，真实运行需要先在本目录执行 `npm install`。
- 真实运行需要 Claude Agent SDK 凭据，以及本地 SDK 设置所需的工具权限。
- Git safety 目前记录 preflight、dirty-tree 风险、diff stat、patch 和 evidence；自动分支/worktree、自动 PR 创建、CI 反馈修复和一键 rollback 仍是后续增强。
- Web UI 已本地化为简体中文，可以启动真实运行，也可以传递运行配置（轮次/turn 限制、权限模式、仅 Planner 模式、各角色模型），能在 Planner 后暂停时审阅并修改 `.agent-loop/spec.md` / `.agent-loop/prd.json` 后继续运行，并能编辑后续运行使用的本地 agent/system 提示语和阶段提示语模板。真实运行现在由后台 job 承载，并通过事件流、状态轮询和 evidence API 暴露进度。

## 使用方法

在本目录中执行：

```bash
npm install
node ./bin/agent-loop.js --help
node ./bin/agent-loop.js init
node ./bin/agent-loop.js init --cwd /path/to/target-repo

# 经典 ralph-compound 模板（默认）
node ./bin/agent-loop.js run "Add a small feature" --dry-run
node ./bin/agent-loop.js run "Add a small feature" --planner-only
node ./bin/agent-loop.js resume

# 选别的内置模板
node ./bin/agent-loop.js templates
node ./bin/agent-loop.js run "Review this diff" --template parallel-review
node ./bin/agent-loop.js run "Refactor auth module" --template map-reduce-refactor

# 让 meta-planner 自动产出自定义 DAG，再用它跑
node ./bin/agent-loop.js plan "Use 5 parallel researchers to scope X, then implement"
node ./bin/agent-loop.js run "<your prompt>" --template dynamic

# 模型 / 权限 / 验证 / Web UI
node ./bin/agent-loop.js run "Add a small feature" --planner-model claude-opus-4-1 --worker-model claude-sonnet-4-5 --judge-model claude-opus-4-1 --permission-mode acceptEdits
node ./bin/agent-loop.js verify
node ./bin/agent-loop.js status
node ./bin/agent-loop.js ui
node ./bin/agent-loop.js ui --cwd /path/to/target-repo
```

默认情况下，CLI 和 Web UI 会把启动命令时的当前目录作为目标项目目录；也可以用 `--cwd /path/to/target-repo` 在运行前明确选择目标项目目录，无需先 `cd`。

然后打开 <http://127.0.0.1:4317>。简体中文 UI 暴露了与 CLI 相同的核心运行配置：最大轮数、最大 turns、权限模式、仅 Planner 模式，以及 Planner/Worker/Judge 模型覆盖。这些值会提交到 `/api/run`，并持久化到创建运行的 `.agent-loop/run.json` 中。提示语编辑器会加载并保存 `.agent-loop/prompts/` 下的可编辑提示语文件；保存后的 agent 系统提示语和阶段任务提示语模板会被后续真实运行使用。

## 脚本

```bash
npm run check
npm run smoke
npm start
```

## 本地状态

`agent-loop` 会把目标项目的状态写入 `.agent-loop/`：

```text
.agent-loop/
  run.json                              # schemaVersion=2, nodes[] + 兼容 phases[]
  spec.md
  prd.json
  progress.txt
  judge-<round>.md
  judge-<round>.json
  logs/
    verification.log
  diffs/
    worker-<round>-after.patch
  evidence/
    git-preflight.json
    worker-<round>-git-after.json
  events.ndjson                         # 事件流，含 node_start / node_end / node_retry / node_cache_hit
  control.json
  nodes/                                # 每节点每轮产出
    <recordId>/
      <iteration>.json                  # { text, json, sessionId, totalCostUsd, ... }
  cache/                                # 命中型节点缓存
    <hash>.json
  templates/                            # 用户自定义 DAG 模板，覆盖同名内置模板
    <name>.json
  prompts/
    planner.md
    worker.md
    judge.md
    phase-prompts.json
```

## 当前可迭代方向

1. 将 Git safety 从 evidence 记录增强为自动 branch/worktree、逐轮 commit checkpoint 和一键 rollback。
2. 将 pause/cancel 从 after-phase 控制标记增强为 SDK 级中断、阶段重试和失败恢复状态机。
3. 为 PRD、Judge verdict、evidence、events 和 run state 补充更严格 schema 与迁移机制。
4. 接入 GitHub/GitLab PR、CI 状态、review comments 和内部 ticket 系统。
5. 增强 policy engine：按路径、命令、CODEOWNERS、secret/迁移风险决定是否需要人工介入。
6. 建立自动化度量：无需人工介入率、平均轮次、Judge FAIL 自动修复率、自动 PR merge rate 和返工率。

## 已完成的里程碑

1. **可信本地运行基础**：共享参数校验、请求体限制、静态路径安全、非 loopback API token、run control marker、role-based tools 和 Git preflight。
2. **可观察后台运行**：Web job manager、`/api/events` SSE/JSON backlog、append-only events、Agent SDK event 持久化和 Live events UI。
3. **自动交付小变更基础**：Worker 前后 Git evidence、diff patch 归档、结构化 Judge verdict、Quality Gate、Changes/Evidence API 与 UI。
4. **内部平台化入口**：Autopilot 等级、PRD stories summary、独立 toast、run controls，以及为后续 PR/CI/policy 集成预留的 artifact/event 协议。
