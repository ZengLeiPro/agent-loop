import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './core.js';

export async function writeEvidence(cwd, name, evidence) {
  const path = join(stateDir(cwd), 'evidence', `${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}

export async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

export function parseJudgeMarkdown(markdown) {
  const verdictMatches = [...String(markdown || '').matchAll(/VERDICT\s*:\s*(PASS|FAIL)/gi)];
  if (verdictMatches.length === 0) return { verdict: null, source: 'markdown' };
  return { verdict: verdictMatches.at(-1)[1].toUpperCase(), source: 'markdown' };
}

export async function writeJudgeVerdictJson({ cwd = process.cwd(), round = 0 } = {}) {
  const judgeMdPath = join(stateDir(cwd), `judge-${round}.md`);
  const markdown = existsSync(judgeMdPath) ? await readFile(judgeMdPath, 'utf8') : '';
  const parsed = parseJudgeMarkdown(markdown);
  const verdict = {
    round,
    source: parsed.source,
    verdict: parsed.verdict,
    pass: parsed.verdict === 'PASS',
    capturedAt: new Date().toISOString(),
    markdownPath: judgeMdPath
  };
  const path = join(stateDir(cwd), `judge-${round}.json`);
  await writeFile(path, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  return verdict;
}
