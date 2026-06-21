// Agent 节点执行器：跑一次 Claude Agent SDK query，把产出（text/sessionId/cost/json）回写 runtime。

import { ClaudeAgentAdapter } from '../../claude-agent-adapter.js';
import { allowedToolsForAgentType } from '../../policy.js';
import { writeJudgeVerdictJson } from '../../evidence.js';
import { collectGitEvidence } from '../../git-safety.js';
import { writeEvidence } from '../../evidence.js';
import { renderTemplate } from '../template.js';

export async function executeAgentNode({
  node,
  cwd,
  runtime,
  iteration = 0,
  models = {},
  adapterDefaults = {},
  toolOverrides = {},
  systemPromptResolver,
  adapterFactory,
  onEvent = () => {}
}) {
  const allowedTools = node.allowedTools && node.allowedTools.length
    ? node.allowedTools
    : allowedToolsForAgentType(node.agentType, toolOverrides);

  // models[node.model] = 角色键名(如 "worker")到真实 model id 的映射。
  // 命中就用,缺失留 undefined → adapter 不传 --model → SDK 走默认。
  // 不要 fallback 到 node.model 本身(那是角色键名,不是合法 model id,会让 SDK 调 API 404)。
  const modelId = models[node.model] || undefined;

  const createAdapter = adapterFactory || (options => new ClaudeAgentAdapter(options));
  const adapter = createAdapter({
    ...adapterDefaults,
    model: modelId,
    allowedTools
  });

  const userPrompt = renderTemplate(node.user || '', runtime.toEvalScope());
  const systemPromptFile = await systemPromptResolver({ promptRef: node.promptRef, cwd, nodeId: node.id });

  // Capture before-git evidence for writer-type nodes that opt in.
  let gitBeforePath = null;
  if (node.hooks?.captureGitEvidence) {
    const before = await collectGitEvidence({ cwd, phaseId: `${node.id}-${iteration}`, role: node.agentType, round: iteration, moment: 'before' });
    gitBeforePath = await writeEvidence(cwd, `${node.id}-${iteration}-git-before`, before);
    onEvent({ type: 'git_evidence', nodeId: node.id, iteration, moment: 'before', evidencePath: gitBeforePath });
  }

  let result;
  try {
    result = await adapter.run({
      cwd,
      role: node.agentType,
      prompt: userPrompt,
      systemPromptFile,
      onEvent: event => onEvent({ ...event, nodeId: node.id, iteration })
    });
  } catch (error) {
    if (node.hooks?.captureGitEvidence) {
      const after = await collectGitEvidence({ cwd, phaseId: `${node.id}-${iteration}`, role: node.agentType, round: iteration, moment: 'after-failed' });
      const gitAfterFailedPath = await writeEvidence(cwd, `${node.id}-${iteration}-git-after-failed`, after);
      onEvent({ type: 'git_evidence', nodeId: node.id, iteration, moment: 'after-failed', evidencePath: gitAfterFailedPath });
    }
    throw error;
  }

  let gitAfterPath = null;
  if (node.hooks?.captureGitEvidence) {
    const after = await collectGitEvidence({ cwd, phaseId: `${node.id}-${iteration}`, role: node.agentType, round: iteration, moment: 'after' });
    gitAfterPath = await writeEvidence(cwd, `${node.id}-${iteration}-git-after`, after);
    onEvent({ type: 'git_evidence', nodeId: node.id, iteration, moment: 'after', evidencePath: gitAfterPath });
  }

  let json = null;
  if (node.hooks?.writeJudgeVerdictJson) {
    json = await writeJudgeVerdictJson({ cwd, round: iteration });
  }

  const output = {
    text: result.resultText,
    sessionId: result.sessionId,
    totalCostUsd: result.totalCostUsd,
    model: modelId,
    json,
    gitBefore: gitBeforePath,
    gitAfter: gitAfterPath,
    completedAt: new Date().toISOString()
  };

  return output;
}
