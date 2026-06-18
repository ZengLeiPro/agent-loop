import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './core.js';

function jobsDir(cwd) {
  return join(stateDir(cwd), 'jobs');
}

export class JobManager {
  constructor({ cwd = process.cwd(), eventHub } = {}) {
    this.cwd = cwd;
    this.eventHub = eventHub;
    this.jobs = new Map();
    this.ready = this.#loadJobs();
  }

  async #loadJobs() {
    const dir = jobsDir(this.cwd);
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(dir, entry.name);
      try {
        const job = JSON.parse(await readFile(path, 'utf8'));
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'interrupted';
          job.updatedAt = new Date().toISOString();
          job.interruptedAt = job.updatedAt;
        }
        this.jobs.set(job.id, job);
        await this.#persist(job);
      } catch {
        // Ignore corrupt job metadata; event logs still preserve diagnostics.
      }
    }
  }

  async #persist(job) {
    await mkdir(jobsDir(this.cwd), { recursive: true });
    await writeFile(join(jobsDir(this.cwd), `${job.id}.json`), `${JSON.stringify(this.publicJob(job), null, 2)}\n`, 'utf8');
  }

  all() {
    return [...this.jobs.values()].map(job => this.publicJob(job));
  }

  active() {
    return this.all().filter(job => ['queued', 'running'].includes(job.status));
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  async create({ type, runId, task, metadata = {} }) {
    await this.ready;
    const now = new Date().toISOString();
    const job = {
      id: `job_${randomUUID().slice(0, 12)}`,
      type,
      runId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      pid: process.pid,
      metadata
    };
    this.jobs.set(job.id, job);
    await this.#persist(job);
    this.eventHub?.publish({ type: 'job.queued', job: this.publicJob(job), runId }).catch(() => {});
    queueMicrotask(() => this.#run(job, task));
    return this.publicJob(job);
  }

  async #heartbeat(job) {
    if (!['queued', 'running'].includes(job.status)) return;
    job.heartbeatAt = new Date().toISOString();
    job.updatedAt = job.heartbeatAt;
    await this.#persist(job);
  }

  async #run(job, task) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.heartbeatAt = job.startedAt;
    await this.#persist(job);
    await this.eventHub?.publish({ type: 'job.started', job: this.publicJob(job), runId: job.runId });
    const heartbeat = setInterval(() => this.#heartbeat(job).catch(() => {}), 5000);
    try {
      const result = await task(job);
      job.status = 'completed';
      job.result = result;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.heartbeatAt = job.completedAt;
      await this.#persist(job);
      await this.eventHub?.publish({ type: 'job.completed', job: this.publicJob(job), runId: job.runId });
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.heartbeatAt = job.completedAt;
      await this.#persist(job);
      await this.eventHub?.publish({ type: 'job.failed', job: this.publicJob(job), runId: job.runId, error: job.error });
    } finally {
      clearInterval(heartbeat);
    }
  }

  publicJob(job) {
    return {
      id: job.id,
      type: job.type,
      runId: job.runId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      interruptedAt: job.interruptedAt,
      heartbeatAt: job.heartbeatAt,
      pid: job.pid,
      error: job.error,
      metadata: job.metadata
    };
  }
}
