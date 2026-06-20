// Extracted from runner.js so both runner and DAG tools can call it without a circular import.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './core.js';
import { readJsonIfExists } from './evidence.js';

export async function verifyRunCompletion(cwd = process.cwd(), round = 0) {
  const dir = stateDir(cwd);
  const progressPath = join(dir, 'progress.txt');
  const prdPath = join(dir, 'prd.json');
  const judgePath = join(dir, `judge-${round}.md`);

  const progress = existsSync(progressPath) ? await readFile(progressPath, 'utf8') : '';
  const progressLastLine = progress.trimEnd().split(/\r?\n/).at(-1) || '';
  const sentinelOk = /^<promise>\s*COMPLETE\s*<\/promise>$/i.test(progressLastLine);

  let passCountOk = false;
  if (existsSync(prdPath)) {
    try {
      const prd = JSON.parse(await readFile(prdPath, 'utf8'));
      const stories = Array.isArray(prd.userStories) ? prd.userStories : [];
      passCountOk = stories.length > 0 && stories.every(story => story?.passes === true);
    } catch {
      passCountOk = false;
    }
  }

  const judge = existsSync(judgePath) ? await readFile(judgePath, 'utf8') : '';
  const structuredJudge = await readJsonIfExists(join(dir, `judge-${round}.json`));
  let judgeOk = false;
  let judgeSource = 'markdown';
  if (structuredJudge?.verdict) {
    judgeOk = String(structuredJudge.verdict).toUpperCase() === 'PASS';
    judgeSource = 'json';
  } else {
    const verdictMatches = [...judge.matchAll(/VERDICT\s*:\s*(PASS|FAIL)/gi)];
    judgeOk = verdictMatches.length > 0 && verdictMatches.at(-1)[1].toUpperCase() === 'PASS';
  }

  return { sentinelOk, passCountOk, judgeOk, judgeSource, complete: sentinelOk && passCountOk && judgeOk };
}
