import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './core.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(__dirname, '..');
const bundledPromptsRoot = join(projectRoot, 'prompts', 'ralph-compound');

export const PROMPT_ROLES = ['planner', 'worker', 'judge'];
export const PHASE_PROMPT_KEYS = ['planner', 'worker', 'judge'];
export const PHASE_PROMPTS_FILE = 'phase-prompts.json';

export const DEFAULT_PHASE_PROMPTS = {
  planner: '请为以下请求创建 .agent-loop/spec.md 和 .agent-loop/prd.json：\n\n{{prompt}}',
  worker: 'Round {{round}}. 阅读 .agent-loop/spec.md 和 .agent-loop/prd.json。只实现一个未完成 story，更新 bookkeeping，并 commit。',
  judge: 'Round {{round}}. 审计最新 worker round，写入 .agent-loop/judge-{{round}}.md，并以 VERDICT: PASS 或 VERDICT: FAIL 结尾。'
};

function rolePromptFile(cwd, role) {
  return join(stateDir(cwd), 'prompts', `${role}.md`);
}

function bundledPromptFile(role) {
  return join(bundledPromptsRoot, `${role}.md`);
}

function phasePromptsFile(cwd) {
  return join(stateDir(cwd), 'prompts', PHASE_PROMPTS_FILE);
}

async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function migrateLegacyPromptProtocol(path) {
  const text = await readFile(path, 'utf8');
  const legacyStateDirPattern = new RegExp('\\.' + 'harness', 'g');
  const migrated = text.replace(legacyStateDirPattern, '.agent-loop');
  if (migrated !== text) await writeFile(path, migrated, 'utf8');
}

export async function ensureEditablePrompts(cwd = process.cwd()) {
  for (const role of PROMPT_ROLES) {
    const localPath = rolePromptFile(cwd, role);
    if (!existsSync(localPath)) {
      await ensureParent(localPath);
      await writeFile(localPath, await readFile(bundledPromptFile(role), 'utf8'), 'utf8');
    } else {
      await migrateLegacyPromptProtocol(localPath);
    }
  }

  const phasePath = phasePromptsFile(cwd);
  if (!existsSync(phasePath)) {
    await ensureParent(phasePath);
    await writeFile(phasePath, `${JSON.stringify(DEFAULT_PHASE_PROMPTS, null, 2)}\n`, 'utf8');
  }
}

export async function readEditablePrompts(cwd = process.cwd()) {
  await ensureEditablePrompts(cwd);
  const systemPrompts = {};
  for (const role of PROMPT_ROLES) {
    systemPrompts[role] = await readFile(rolePromptFile(cwd, role), 'utf8');
  }

  const phasePrompts = {
    ...DEFAULT_PHASE_PROMPTS,
    ...JSON.parse(await readFile(phasePromptsFile(cwd), 'utf8'))
  };

  return { systemPrompts, phasePrompts };
}

export async function writeEditablePrompts({ cwd = process.cwd(), systemPrompts = {}, phasePrompts = {} } = {}) {
  await ensureEditablePrompts(cwd);

  for (const role of PROMPT_ROLES) {
    if (Object.hasOwn(systemPrompts, role)) {
      await writeFile(rolePromptFile(cwd, role), String(systemPrompts[role]), 'utf8');
    }
  }

  const mergedPhasePrompts = {
    ...DEFAULT_PHASE_PROMPTS,
    ...JSON.parse(await readFile(phasePromptsFile(cwd), 'utf8'))
  };
  for (const key of PHASE_PROMPT_KEYS) {
    if (Object.hasOwn(phasePrompts, key)) mergedPhasePrompts[key] = String(phasePrompts[key]);
  }
  await writeFile(phasePromptsFile(cwd), `${JSON.stringify(mergedPhasePrompts, null, 2)}\n`, 'utf8');

  return readEditablePrompts(cwd);
}

export function systemPromptFile(cwd, role) {
  return rolePromptFile(cwd, role);
}

export function renderPhasePrompt(template, values = {}) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ));
}
