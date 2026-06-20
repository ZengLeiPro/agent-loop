// DAG 模板加载器。
//
// 模板从两个位置查找（按优先级）：
// 1. <cwd>/.agent-loop/templates/<name>.json  ← 用户在目标项目里的覆盖
// 2. <projectRoot>/templates/<name>.json       ← agent-loop 内置模板
//
// 这样用户可以为单个项目自定义 DAG，又不影响其他项目。

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../core.js';
import { parseAndValidateDag } from './schema.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const bundledTemplatesRoot = join(projectRoot, 'templates');

const TEMPLATE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function userTemplatesDir(cwd) {
  return join(stateDir(cwd), 'templates');
}

export function bundledTemplatesDir() {
  return bundledTemplatesRoot;
}

export async function listTemplates(cwd = process.cwd()) {
  const entries = new Map();
  const dirs = [
    { dir: bundledTemplatesRoot, source: 'bundled' },
    { dir: userTemplatesDir(cwd), source: 'user' }
  ];
  for (const { dir, source } of dirs) {
    const items = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const item of items) {
      if (!item.isFile() || !item.name.endsWith('.json')) continue;
      const name = item.name.slice(0, -'.json'.length);
      if (!TEMPLATE_NAME_PATTERN.test(name)) continue;
      // User entries shadow bundled ones because we iterate bundled first.
      entries.set(name, { name, source, path: join(dir, item.name) });
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function templatePath(cwd, name) {
  if (typeof name !== 'string' || !TEMPLATE_NAME_PATTERN.test(name)) {
    const error = new Error(`Invalid template name "${name}". Must match ${TEMPLATE_NAME_PATTERN}.`);
    error.statusCode = 400;
    throw error;
  }
  const userPath = join(userTemplatesDir(cwd), `${name}.json`);
  if (existsSync(userPath)) return userPath;
  const bundledPath = join(bundledTemplatesRoot, `${name}.json`);
  if (existsSync(bundledPath)) return bundledPath;
  const error = new Error(`Template "${name}" not found. Looked under: ${userPath}, ${bundledPath}`);
  error.statusCode = 404;
  throw error;
}

export async function loadTemplate(name, { cwd = process.cwd(), knownTools = new Set() } = {}) {
  const path = templatePath(cwd, name);
  const raw = await readFile(path, 'utf8');
  const dag = parseAndValidateDag(raw, { knownTools });
  return { name, path, dag };
}
