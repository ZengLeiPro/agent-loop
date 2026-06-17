# agent-loop

`agent-loop` 是一个独立、本地优先的 Agent Loop 项目，后续计划拆分为独立的 GitHub 仓库。它将一个简单的 CLI 与轻量级 Web UI 打包在一起，不依赖父级应用。

## 目标

- 将项目完整地自包含在当前目录中。
- 支持从 macOS 上的 Git checkout 本地运行。
- 提供通用的 Planner → Worker → Judge 循环基础能力。
- 将目标仓库的项目本地状态写入 `.agent-loop/`。
- 内置一个小型 Web UI，方便不想完全通过 CLI 操作的用户使用。

## 当前状态

项目仍处于早期实现阶段，但已经不再只是状态脚手架：

- 依赖较少的 Node.js CLI；
- 本地 HTTP 服务器与内置静态 Web UI；
- 本地运行状态创建；
- 内置 Ralph Compound 风格模板与提示语占位文件；
- 初始 `@anthropic-ai/claude-agent-sdk` 适配器；
- 初始 Planner → Worker → Judge runner 循环；
- 基于 sentinel、PRD pass 计数和 Judge verdict 的完成校验。

重要限制：

- 拆分或 checkout 项目后，真实运行需要先在本目录执行 `npm install`。
- 真实运行需要 Claude Agent SDK 凭据，以及本地 SDK 设置所需的工具权限。
- Git 安全检查、回滚、长任务暂停/取消，以及健壮的逐轮 diff review 仍是下一步工作。
- Web UI 已本地化为简体中文，可以启动真实运行，也可以传递运行配置（轮次/turn 限制、权限模式、仅 Planner 模式、各角色模型），能在 Planner 后暂停时审阅并修改 `.agent-loop/spec.md` / `.agent-loop/prd.json` 后继续运行，并能编辑后续运行使用的本地 agent/system 提示语和阶段提示语模板。长时间真实执行目前仍是一次简单 HTTP 请求，而不是带流式日志的后台任务队列。

## 使用方法

在本目录中执行：

```bash
npm install
node ./bin/agent-loop.js --help
node ./bin/agent-loop.js init
node ./bin/agent-loop.js init --cwd /path/to/target-repo
node ./bin/agent-loop.js run "Add a small feature" --dry-run
node ./bin/agent-loop.js run "Add a small feature" --planner-only
node ./bin/agent-loop.js resume
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
  run.json
  spec.md
  prd.json
  progress.txt
  judge-<round>.md
  logs/
  prompts/
    planner.md
    worker.md
    judge.md
    phase-prompts.json
```

## 当前可迭代方向

1. 校验并收紧 Claude Agent SDK 的默认权限与工具策略，确保符合真实运行环境的安全要求。
2. 增加 Git 安全检查、每轮提交记录、diff 归档与回滚能力，降低自动修改代码时的风险。
3. 完善 pause/cancel 命令和后台状态机，支持长任务中断与取消。
4. 将 Web 端真实运行从单次长 HTTP 请求改造成后台任务队列，并提供流式日志、进度和错误展示。
5. 为完成校验、失败恢复、PRD 解析、Judge verdict 提取和 prompt 渲染补充自动化测试。
6. 强化运行观测性：记录每个角色的输入、输出摘要、耗时、成本、会话 ID 和失败原因。
7. 改进配置体验：为权限模式、模型名和运行参数提供枚举/校验/默认值说明，避免无效配置进入运行。
8. 完善文档与示例：补充真实运行前置条件、凭据配置、常见故障排查，以及一个端到端 dry run/真实 run 示例。

## 已规划的下一步

1. 校验默认 Claude Agent SDK 权限/工具策略是否匹配准确的内部环境。
2. 增加 Git 安全检查和逐轮 commit/diff 跟踪。
3. 完善 pause/cancel 命令与后台状态机。
4. 将 Web 真实执行改造成带流式日志的后台任务。
5. 增加围绕完成校验和 loop 恢复的测试。
