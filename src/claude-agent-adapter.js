import { readFile } from 'node:fs/promises';

const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'Bash'
];

export class ClaudeAgentAdapter {
  constructor({
    model,
    maxTurns = 50,
    permissionMode = 'acceptEdits',
    allowedTools = DEFAULT_ALLOWED_TOOLS,
    apiKey,
    apiEndpoint,
    effort,
    maxThinkingTokens
  } = {}) {
    this.model = model;
    this.maxTurns = maxTurns;
    this.permissionMode = permissionMode;
    this.allowedTools = allowedTools;
    this.apiKey = apiKey;
    this.apiEndpoint = apiEndpoint;
    this.effort = effort;
    this.maxThinkingTokens = maxThinkingTokens;
  }

  async run({ cwd, prompt, systemPromptFile, role, onEvent = () => {} }) {
    let query;
    try {
      ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch (error) {
      throw new Error([
        'Claude Agent SDK is not installed.',
        'Run `npm install` inside agent-loop, or install dependencies after splitting this folder out.',
        `Original error: ${error instanceof Error ? error.message : String(error)}`
      ].join(' '));
    }

    const systemPrompt = await readFile(systemPromptFile, 'utf8');
    const options = {
      cwd,
      systemPrompt,
      maxTurns: this.maxTurns,
      permissionMode: this.permissionMode,
      ...(this.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      allowedTools: this.allowedTools,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.maxThinkingTokens !== undefined ? { maxThinkingTokens: this.maxThinkingTokens } : {}),
      ...(this.apiKey || this.apiEndpoint ? {
        env: {
          ...process.env,
          ...(this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {}),
          ...(this.apiEndpoint ? { ANTHROPIC_BASE_URL: this.apiEndpoint } : {})
        }
      } : {})
    };

    let resultText = '';
    let sessionId;
    let totalCostUsd = 0;

    for await (const message of query({ prompt, options })) {
      if (typeof message?.session_id === 'string') {
        sessionId = message.session_id;
      }
      if (message?.type === 'system' && message.subtype === 'init') {
        onEvent({ type: 'session', role, sessionId, model: message.model, cwd: message.cwd });
      }
      if (message?.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            resultText += block.text;
            onEvent({ type: 'text', role, text: block.text });
          }
        }
      }
      if (message?.type === 'result') {
        if (typeof message.result === 'string') resultText = message.result;
        if (typeof message.total_cost_usd === 'number') totalCostUsd = message.total_cost_usd;
        onEvent({ type: 'result', role, totalCostUsd, stopReason: message.stop_reason, subtype: message.subtype });
      }
    }

    return { resultText, sessionId, totalCostUsd };
  }
}
