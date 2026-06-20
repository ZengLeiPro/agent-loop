// 节点产出落盘：每个节点每次执行写一份 JSON 到 .agent-loop/nodes/<nodeId>/<iteration>.json。
//
// 设计：
// - 同一 nodeId 在 loop 多轮中产生 iteration=1,2,3... 多份产出；
// - executor 读取下游节点 inputs 时，从这里取「最新」产出（loop 内 iteration 隔离）；
// - 历史产出保留，方便 UI 回看与重放。

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../core.js';

export function nodeOutputDir(cwd, nodeId) {
  return join(stateDir(cwd), 'nodes', nodeId);
}

export function nodeOutputPath(cwd, nodeId, iteration) {
  return join(nodeOutputDir(cwd, nodeId), `${iteration}.json`);
}

export async function writeNodeOutput(cwd, nodeId, iteration, output) {
  const path = nodeOutputPath(cwd, nodeId, iteration);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return path;
}

export async function readNodeOutput(cwd, nodeId, iteration) {
  const path = nodeOutputPath(cwd, nodeId, iteration);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readLatestNodeOutput(cwd, nodeId) {
  const dir = nodeOutputDir(cwd, nodeId);
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir);
  const iterations = entries
    .filter(name => /^\d+\.json$/.test(name))
    .map(name => Number(name.slice(0, -'.json'.length)))
    .sort((a, b) => b - a);
  if (!iterations.length) return null;
  return readNodeOutput(cwd, nodeId, iterations[0]);
}
