import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_ROUNDS, readRun, startRun, stateDir } from './core.js';
import { runAgentLoop } from './runner.js';
import { readEditablePrompts, writeEditablePrompts } from './prompts.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const webRoot = resolve(__dirname, '../web');

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function cleanModels(models = {}) {
  return Object.fromEntries(
    ['planner', 'worker', 'judge']
      .map(role => [role, typeof models[role] === 'string' && models[role].trim() ? models[role].trim() : undefined])
      .filter(([, model]) => model)
  );
}

export function createAgentLoopServer({ cwd = process.cwd() } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/api/status') {
        const run = await readRun(cwd);
        return json(res, 200, { cwd, stateDir: stateDir(cwd), run });
      }
      if (url.pathname === '/api/prompts' && req.method === 'GET') {
        return json(res, 200, await readEditablePrompts(cwd));
      }
      if (url.pathname === '/api/prompts' && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req) || '{}');
        return json(res, 200, await writeEditablePrompts({
          cwd,
          systemPrompts: body.systemPrompts,
          phasePrompts: body.phasePrompts
        }));
      }
      if (url.pathname === '/api/run' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const options = {
          prompt: body.prompt,
          cwd,
          maxRounds: positiveInteger(body.maxRounds, DEFAULT_MAX_ROUNDS, 'maxRounds'),
          maxTurns: positiveInteger(body.maxTurns, DEFAULT_MAX_TURNS, 'maxTurns'),
          permissionMode: typeof body.permissionMode === 'string' && body.permissionMode.trim()
            ? body.permissionMode.trim()
            : DEFAULT_PERMISSION_MODE,
          plannerOnly: Boolean(body.plannerOnly),
          models: cleanModels(body.models)
        };
        const run = body.dryRun !== false
          ? await startRun({ ...options, dryRun: true })
          : await runAgentLoop({
              ...options,
              maxTurns: options.maxTurns,
              permissionMode: options.permissionMode,
              plannerOnly: options.plannerOnly,
              models: options.models
            });
        return json(res, 201, { run });
      }
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(webRoot, safePath.replace(/^\/+/, ''));
      if (!filePath.startsWith(webRoot)) return json(res, 403, { error: 'Forbidden' });
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch (error) {
      if (error?.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function serve({ cwd = process.cwd(), port = 4317, host = '127.0.0.1' } = {}) {
  const server = createAgentLoopServer({ cwd });
  await new Promise(resolveListen => server.listen(port, host, resolveListen));
  return { server, url: `http://${host}:${port}` };
}
