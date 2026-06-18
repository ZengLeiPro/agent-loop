import { randomUUID } from 'node:crypto';

export class JobManager {
  constructor({ eventHub } = {}) {
    this.eventHub = eventHub;
    this.jobs = new Map();
  }

  all() {
    return [...this.jobs.values()].map(job => this.publicJob(job));
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  create({ type, runId, task }) {
    const now = new Date().toISOString();
    const job = {
      id: `job_${randomUUID().slice(0, 12)}`,
      type,
      runId,
      status: 'queued',
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    this.eventHub?.publish({ type: 'job.queued', job: this.publicJob(job), runId }).catch(() => {});
    queueMicrotask(() => this.#run(job, task));
    return this.publicJob(job);
  }

  async #run(job, task) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await this.eventHub?.publish({ type: 'job.started', job: this.publicJob(job), runId: job.runId });
    try {
      const result = await task(job);
      job.status = 'completed';
      job.result = result;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      await this.eventHub?.publish({ type: 'job.completed', job: this.publicJob(job), runId: job.runId });
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      await this.eventHub?.publish({ type: 'job.failed', job: this.publicJob(job), runId: job.runId, error: job.error });
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
      error: job.error
    };
  }
}
