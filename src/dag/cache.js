// 节点输出缓存：(node contract hash + 上游 outputs hash) → 之前的 output。
//
// 用途：长 run 中重复执行同一确定性节点时直接复用旧 output（无 LLM 调用）。
// 失效条件：node 配置变更（schema 字段任何一个变了）、或任一上游节点输出变了。
// 不缓存 hooks 引发的副作用（git evidence / judge JSON），调用方应理解这一点。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../core.js';
import { nodeContractHash } from './schema.js';

const CACHE_VERSION = 1;

export function cacheDir(cwd) {
  return join(stateDir(cwd), 'cache');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function buildCacheKey(node, upstreamOutputs = {}) {
  const contract = nodeContractHash(node);
  const upstream = stableStringify(upstreamOutputs);
  const hash = createHash('sha256').update(`${CACHE_VERSION}|${contract}|${upstream}`).digest('hex');
  return hash.slice(0, 32);
}

export function cachePath(cwd, key) {
  return join(cacheDir(cwd), `${key}.json`);
}

export async function readCacheEntry(cwd, key) {
  const path = cachePath(cwd, key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeCacheEntry(cwd, key, value) {
  const path = cachePath(cwd, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ cachedAt: new Date().toISOString(), value }, null, 2)}\n`, 'utf8');
  return path;
}
