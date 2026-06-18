export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';

export const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']);
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export function optionalStringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new ValidationError(`${name} must be a positive integer.`);
  return number;
}

export function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new ValidationError(`${name} must be a positive integer.`);
  return number;
}

export function optionalPermissionMode(value, fallback = DEFAULT_PERMISSION_MODE) {
  const permissionMode = optionalStringValue(value) || fallback;
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new ValidationError('permissionMode must be one of: default, acceptEdits, plan, dontAsk, auto, bypassPermissions.');
  }
  return permissionMode;
}

export function optionalEffort(value) {
  const effort = optionalStringValue(value);
  if (!effort) return undefined;
  if (!EFFORT_LEVELS.has(effort)) throw new ValidationError('effort must be one of: low, medium, high, xhigh, max.');
  return effort;
}

export function cleanModels(models = {}) {
  return Object.fromEntries(
    ['planner', 'worker', 'judge']
      .map(role => [role, optionalStringValue(models?.[role])])
      .filter(([, model]) => model)
  );
}

export function cleanSdkOptions(sdk = {}) {
  return Object.fromEntries(
    Object.entries({
      apiEndpoint: optionalStringValue(sdk?.apiEndpoint),
      apiKey: optionalStringValue(sdk?.apiKey),
      effort: optionalEffort(sdk?.effort),
      maxThinkingTokens: optionalPositiveInteger(sdk?.maxThinkingTokens, 'maxThinkingTokens')
    }).filter(([, value]) => value !== undefined)
  );
}

export function validateRunOptions(input = {}, { cwd, defaultMaxRounds = 30 } = {}) {
  const prompt = optionalStringValue(input.prompt);
  if (!prompt) throw new ValidationError('A non-empty prompt is required.');
  return {
    prompt,
    cwd,
    maxRounds: positiveInteger(input.maxRounds, defaultMaxRounds, 'maxRounds'),
    maxTurns: positiveInteger(input.maxTurns, DEFAULT_MAX_TURNS, 'maxTurns'),
    permissionMode: optionalPermissionMode(input.permissionMode),
    plannerOnly: Boolean(input.plannerOnly),
    models: cleanModels(input.models),
    sdk: cleanSdkOptions(input.sdk)
  };
}
