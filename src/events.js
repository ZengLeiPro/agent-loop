import { appendFile as appendFileAtomic, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDir } from './core.js';

const MAX_BACKLOG_EVENTS = 500;

export function eventsFile(cwd = process.cwd()) {
  return join(stateDir(cwd), 'events.ndjson');
}

export async function appendEvent(cwd, event) {
  const file = eventsFile(cwd);
  await mkdir(dirname(file), { recursive: true });
  const record = {
    id: event.id || `evt_${randomUUID().slice(0, 12)}`,
    type: event.type || 'message',
    createdAt: event.createdAt || new Date().toISOString(),
    ...event
  };
  await appendFileAtomic(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function readEvents(cwd = process.cwd(), { after, limit = MAX_BACKLOG_EVENTS } = {}) {
  const file = eventsFile(cwd);
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push({ id: `evt_corrupt_${parsed.length}`, type: 'event_log_corrupt', createdAt: new Date().toISOString(), message: 'Skipped a corrupt events.ndjson line.' });
    }
  }
  const afterIndex = after ? parsed.findIndex(event => event.id === after) : -1;
  const filtered = after ? parsed.slice(afterIndex === -1 ? parsed.length : afterIndex + 1) : parsed;
  return filtered.slice(-limit);
}

export class EventHub {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.subscribers = new Set();
    this.writeQueue = Promise.resolve();
  }

  async publish(event) {
    const record = await (this.writeQueue = this.writeQueue.catch(() => {}).then(() => appendEvent(this.cwd, event)));
    for (const send of this.subscribers) send(record);
    return record;
  }

  async backlog(options) {
    return readEvents(this.cwd, options);
  }

  subscribe(send) {
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }
}
