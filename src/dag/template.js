// 极简模板求值：仅支持 {{path}} 形式的成员/索引访问，无 JS eval。
//
// 支持的语法：
//   {{input.prompt}}
//   {{nodes.planner.text}}
//   {{nodes.planner.json.userStories[0].id}}
//   {{loop.round}}
//
// 不支持表达式、函数调用、过滤器、条件——保持简单与安全。

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SEGMENT_RE = /^([a-zA-Z_$][a-zA-Z0-9_$]*)((?:\[\d+\])*)$/;

export class TemplateError extends Error {
  constructor(message, { path, raw } = {}) {
    super(message);
    this.name = 'TemplateError';
    this.path = path;
    this.raw = raw;
  }
}

function parsePath(pathSource) {
  const tokens = pathSource.split('.').map(part => part.trim());
  if (tokens.some(t => !t)) throw new TemplateError(`Invalid template path "${pathSource}".`, { path: pathSource });
  const steps = [];
  for (const token of tokens) {
    const match = SEGMENT_RE.exec(token);
    if (!match) throw new TemplateError(`Invalid path segment "${token}" in "${pathSource}".`, { path: pathSource });
    steps.push({ key: match[1] });
    const indices = match[2].matchAll(/\[(\d+)\]/g);
    for (const m of indices) steps.push({ index: Number(m[1]) });
  }
  return steps;
}

function resolvePath(scope, steps, originalPath) {
  let current = scope;
  for (const step of steps) {
    if (current === undefined || current === null) {
      throw new TemplateError(`Template path "${originalPath}" hit null/undefined before completing.`, { path: originalPath });
    }
    if (step.key !== undefined) {
      if (typeof current !== 'object' || Array.isArray(current)) {
        throw new TemplateError(`Template path "${originalPath}" expected object at "${step.key}".`, { path: originalPath });
      }
      if (!Object.hasOwn(current, step.key)) {
        throw new TemplateError(`Template path "${originalPath}" missing key "${step.key}".`, { path: originalPath });
      }
      current = current[step.key];
    } else {
      if (!Array.isArray(current)) {
        throw new TemplateError(`Template path "${originalPath}" expected array at index ${step.index}.`, { path: originalPath });
      }
      if (step.index >= current.length) {
        throw new TemplateError(`Template path "${originalPath}" index ${step.index} out of bounds (length ${current.length}).`, { path: originalPath });
      }
      current = current[step.index];
    }
  }
  return current;
}

export function stringifyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function renderTemplate(template, scope) {
  if (typeof template !== 'string') return template;
  return template.replace(PLACEHOLDER_RE, (match, rawPath) => {
    const steps = parsePath(rawPath);
    const value = resolvePath(scope, steps, rawPath);
    return stringifyValue(value);
  });
}

// Recursively render template strings in an object literal (used for tool args).
export function renderObjectTemplates(value, scope) {
  if (typeof value === 'string') return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map(entry => renderObjectTemplates(entry, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = renderObjectTemplates(child, scope);
    return out;
  }
  return value;
}
