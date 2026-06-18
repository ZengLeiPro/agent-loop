import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { stateDir } from './core.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), args };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      ok: false,
      stdout: error?.stdout?.trimEnd?.() || '',
      stderr: error?.stderr?.trimEnd?.() || error.message,
      code: error?.code,
      args
    };
  }
}

function parseChangedFiles(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim()
    }))
    .filter(file => !file.path.startsWith('.agent-loop/'));
}

export async function gitPreflight({ cwd = process.cwd(), requireClean = process.env.AGENT_LOOP_GIT_REQUIRE_CLEAN === 'true' } = {}) {
  const repoCheck = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  const evidence = {
    checkedAt: new Date().toISOString(),
    isGitRepo: repoCheck.ok && repoCheck.stdout === 'true',
    requireClean,
    risks: []
  };

  if (!evidence.isGitRepo) {
    evidence.risks.push({ level: requireClean ? 'error' : 'warning', code: 'not_git_repo', message: 'cwd is not inside a Git work tree' });
    evidence.blocked = requireClean;
    return evidence;
  }

  const [root, head, branch, status] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true }),
    git(cwd, ['rev-parse', '--short=12', 'HEAD'], { allowFailure: true }),
    git(cwd, ['branch', '--show-current'], { allowFailure: true }),
    git(cwd, ['status', '--short'], { allowFailure: true })
  ]);

  evidence.gitRoot = root.stdout || null;
  evidence.head = head.ok ? head.stdout : null;
  evidence.branch = branch.stdout || null;
  evidence.changedFiles = parseChangedFiles(status.stdout || '');
  evidence.dirty = evidence.changedFiles.length > 0;
  if (evidence.dirty) {
    evidence.risks.push({
      level: requireClean ? 'error' : 'warning',
      code: 'dirty_worktree',
      message: 'work tree has pre-existing changes; continuing because dirty trees are allowed by default',
      changedFileCount: evidence.changedFiles.length
    });
  }
  evidence.blocked = Boolean(requireClean && evidence.risks.some(risk => risk.level === 'error'));
  return evidence;
}

export async function collectGitEvidence({ cwd = process.cwd(), phaseId, role, round, moment } = {}) {
  const repoCheck = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  const evidence = {
    capturedAt: new Date().toISOString(),
    phaseId,
    role,
    round: round ?? 0,
    moment,
    isGitRepo: repoCheck.ok && repoCheck.stdout === 'true'
  };

  if (!evidence.isGitRepo) return evidence;

  const [root, head, branch, status, diffStat, patch] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true }),
    git(cwd, ['rev-parse', '--short=12', 'HEAD'], { allowFailure: true }),
    git(cwd, ['branch', '--show-current'], { allowFailure: true }),
    git(cwd, ['status', '--short'], { allowFailure: true }),
    git(cwd, ['diff', '--stat', 'HEAD', '--', '.', ':!.agent-loop'], { allowFailure: true }),
    git(cwd, ['diff', '--binary', 'HEAD', '--', '.', ':!.agent-loop'], { allowFailure: true })
  ]);

  evidence.gitRoot = root.stdout || null;
  evidence.head = head.ok ? head.stdout : null;
  evidence.branch = branch.stdout || null;
  evidence.changedFiles = parseChangedFiles(status.stdout || '');
  evidence.diffStat = diffStat.stdout || '';
  evidence.patchPath = null;

  const patchPath = join(stateDir(cwd), 'diffs', `${phaseId}-${moment}.patch`);
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, `${patch.stdout || ''}${patch.stdout ? '\n' : ''}`, 'utf8');
  evidence.patchPath = patchPath;
  evidence.patchBytes = Buffer.byteLength(patch.stdout || '', 'utf8');
  return evidence;
}
