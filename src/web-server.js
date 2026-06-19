import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_ROUNDS, readReviewFiles, readRun, startRun, stateDir, writeReviewFiles } from './core.js';
import { runAgentLoop } from './runner.js';
import { readEditablePrompts, writeEditablePrompts } from './prompts.js';
import { validateRunOptions, ValidationError } from './validation.js';
import { EventHub } from './events.js';
import { JobManager } from './job-manager.js';
import { readControl, writeControl } from './control.js';
import { assertPermissionModeAllowed } from './policy.js';
import { clearRunLock, isActiveRun, readRunLock, writeRunLock } from './run-lock.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const webRoot = resolve(__dirname, '../web');
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req, { limit = DEFAULT_BODY_LIMIT_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, `Request body exceeds ${limit} bytes.`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Unable to read request body.');
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function isLoopback(remoteAddress = '') {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress) || remoteAddress.startsWith('::ffff:127.');
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(req, url) {
  const authorization = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] || req.headers['x-agent-loop-token'] || url.searchParams.get('token') || '';
}

function requireApiAccess(req, url, apiToken) {
  if (!url.pathname.startsWith('/api/')) return;
  if (isLoopback(req.socket.remoteAddress)) return;
  if (safeEqual(String(requestToken(req, url)), apiToken)) return;
  throw new HttpError(401, 'API token required for non-loopback requests.');
}

const appPagePaths = new Set(['/', '/launch', '/monitor', '/events', '/quality', '/debug', '/review', '/prompts']);

function resolveStaticPath(pathname) {
  const normalizedPathname = appPagePaths.has(pathname) ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(normalizedPathname);
  } catch {
    throw new HttpError(400, 'Invalid URL path.');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'Invalid URL path.');
  const filePath = resolve(webRoot, `.${decoded}`);
  const fromRoot = relative(webRoot, filePath);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new HttpError(403, 'Forbidden');
  return filePath;
}

function sendSse(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJsonArtifact(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function listJsonArtifacts(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
  const artifacts = await Promise.all(files.map(async entry => {
    const path = join(dir, entry.name);
    return {
      name: basename(entry.name, '.json'),
      path,
      data: await readJsonArtifact(path)
    };
  }));
  return artifacts.filter(artifact => artifact.data !== null);
}

async function readArtifacts(cwd) {
  const dir = stateDir(cwd);
  const run = await readRun(cwd);
  const evidence = await listJsonArtifacts(join(dir, 'evidence'));
  const judgeArtifacts = await listJsonArtifacts(dir);
  const judges = judgeArtifacts
    .filter(artifact => /^judge-\d+$/.test(artifact.name))
    .sort((a, b) => Number(a.name.slice('judge-'.length)) - Number(b.name.slice('judge-'.length)));
  const latestJudge = judges.at(-1)?.data || null;
  const verificationLog = await readFile(join(dir, 'logs', 'verification.log'), 'utf8').catch(() => '');
  const latestWorker = [...(run?.phases || [])].reverse().find(phase => phase.role === 'worker');
  const gitAfter = evidence.find(artifact => artifact.path === latestWorker?.gitAfter)?.data
    || evidence.find(artifact => artifact.name === `${latestWorker?.id}-git-after`)?.data
    || null;
  return {
    artifacts: {
      qualityGate: {
        verdict: latestJudge?.verdict || 'unknown',
        checks: [
          { name: 'Latest Judge', status: latestJudge?.verdict || 'missing' },
          { name: 'Run status', status: run?.status || 'none' },
          { name: 'Verification log', status: verificationLog ? 'available' : 'missing' }
        ]
      },
      changes: gitAfter?.changedFiles || [],
      evidence: evidence.map(artifact => ({
        name: artifact.name,
        path: artifact.path,
        status: artifact.data?.blocked ? 'blocked' : artifact.data?.verdict || artifact.data?.moment || 'captured',
        detail: artifact.data?.diffStat || artifact.data?.message || artifact.data?.capturedAt || artifact.data?.checkedAt
      })),
      judge: latestJudge,
      verificationLog: verificationLog.split(/\r?\n/).filter(Boolean).slice(-20)
    }
  };
}

async function handleEvents(req, res, url, eventHub) {
  const wantsStream = req.headers.accept?.includes('text/event-stream') || url.searchParams.get('stream') === '1';
  const after = url.searchParams.get('after') || undefined;
  const limit = Number(url.searchParams.get('limit') || '500');
  const events = await eventHub.backlog({ after, limit: Number.isInteger(limit) && limit > 0 ? limit : 500 });
  if (!wantsStream) return json(res, 200, { events });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  for (const event of events) sendSse(res, event);
  const unsubscribe = eventHub.subscribe(event => sendSse(res, event));
  req.on('close', unsubscribe);
  res.write(': connected\n\n');
}

export function createAgentLoopServer({ cwd = process.cwd(), apiToken = process.env.AGENT_LOOP_API_TOKEN || randomBytes(24).toString('hex') } = {}) {
  const eventHub = new EventHub({ cwd });
  const jobs = new JobManager({ cwd, eventHub });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      requireApiAccess(req, url, apiToken);

      if (url.pathname === '/api/status') {
        await jobs.ready;
        const run = await readRun(cwd);
        return json(res, 200, { cwd, stateDir: stateDir(cwd), run, jobs: jobs.all(), lock: await readRunLock(cwd), control: await readControl(cwd) });
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        return handleEvents(req, res, url, eventHub);
      }
      if ((url.pathname === '/api/artifacts' || url.pathname === '/api/evidence') && req.method === 'GET') {
        return json(res, 200, await readArtifacts(cwd));
      }
      if (url.pathname === '/api/control' && req.method === 'GET') {
        return json(res, 200, { control: await readControl(cwd) });
      }
      if (url.pathname === '/api/control' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const control = await writeControl(cwd, { action: body.action, reason: body.reason });
        await eventHub.publish({ type: 'control.requested', control });
        return json(res, 202, { control });
      }
      if (url.pathname === '/api/prompts' && req.method === 'GET') {
        return json(res, 200, await readEditablePrompts(cwd));
      }
      if (url.pathname === '/api/review' && req.method === 'GET') {
        return json(res, 200, { files: await readReviewFiles(cwd) });
      }
      if (url.pathname === '/api/review' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        return json(res, 200, { files: await writeReviewFiles({ cwd, files: body.files }) });
      }
      if (url.pathname === '/api/prompts' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        return json(res, 200, await writeEditablePrompts({
          cwd,
          systemPrompts: body.systemPrompts,
          phasePrompts: body.phasePrompts
        }));
      }
      if (url.pathname === '/api/resume' && req.method === 'POST') {
        const run = await readRun(cwd);
        if (!run) return json(res, 409, { error: 'No run exists to resume.' });
        if (run.status !== 'waiting-for-review') {
          return json(res, 409, { error: 'Only runs waiting for review can be resumed.' });
        }
        if (jobs.active().length > 0) return json(res, 409, { error: 'An agent-loop job is already active for this directory.' });
        await writeRunLock(cwd, { runId: run.id, type: 'resume' });
        const job = await jobs.create({
          type: 'resume',
          runId: run.id,
          task: async () => {
            try {
              return await runAgentLoop({ cwd, plannerOnly: false, publishEvent: event => eventHub.publish(event) });
            } finally {
              await clearRunLock(cwd, { runId: run.id });
            }
          }
        });
        return json(res, 202, { run, job });
      }
      if (url.pathname === '/api/run' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await jobs.ready;
        const existingRun = await readRun(cwd);
        if (isActiveRun(existingRun) || jobs.active().length > 0) return json(res, 409, { error: 'An agent-loop run is already active for this directory.' });
        const options = validateRunOptions(body, { cwd, defaultMaxRounds: DEFAULT_MAX_ROUNDS });
        assertPermissionModeAllowed(options.permissionMode, { allowDangerous: body.allowDangerous === true });
        const run = await startRun({ ...options, dryRun: body.dryRun !== false });
        await writeRunLock(cwd, { runId: run.id, type: body.dryRun !== false ? 'dry-run' : 'run' });
        const job = await jobs.create({
          type: body.dryRun !== false ? 'dry-run' : 'run',
          runId: run.id,
          task: async () => {
            try {
              return body.dryRun !== false
                ? run
                : await runAgentLoop({
                    cwd,
                    maxRounds: options.maxRounds,
                    maxTurns: options.maxTurns,
                    permissionMode: options.permissionMode,
                    plannerOnly: options.plannerOnly,
                    models: options.models,
                    sdk: options.sdk,
                    publishEvent: event => eventHub.publish(event)
                  });
            } finally {
              await clearRunLock(cwd, { runId: run.id });
            }
          },
          metadata: { permissionMode: options.permissionMode, plannerOnly: options.plannerOnly }
        });
        return json(res, body.dryRun !== false ? 201 : 202, { run, job });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

      const filePath = resolveStaticPath(url.pathname);
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch (error) {
      if (error?.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
      if (error instanceof HttpError || error instanceof ValidationError || Number.isInteger(error?.statusCode)) {
        return json(res, error.statusCode || 400, { error: error.message });
      }
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.agentLoopApiToken = apiToken;
  return server;
}

export async function serve({ cwd = process.cwd(), port = 4317, host = '127.0.0.1', apiToken } = {}) {
  const server = createAgentLoopServer({ cwd, apiToken });
  await new Promise(resolveListen => server.listen(port, host, resolveListen));
  return { server, url: `http://${host}:${port}`, apiToken: server.agentLoopApiToken };
}
