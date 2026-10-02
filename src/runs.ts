/** Local run journal for inspection and recovering finished answers, not action replay. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGINE_HOME } from './config.ts';
import type { ChatMessage } from './assistant.ts';

type RunState = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface RunRecord {
  ownerPid?: number;
  id: string; state: RunState; prompt: string; createdAt: string; updatedAt: string;
  model?: string; provider?: string; answer?: string; error?: string;
  events: Array<Record<string, unknown> & { type: string; at: string }>;
  checkpoint?: Array<{ role: string; content: string; tool_name?: string }>;
}
const ACTIVE = new Set<RunState>(['queued', 'running', 'waiting_approval']);
export class RunStore {
  readonly directory: string;
  constructor(directory = join(IMAGINE_HOME, 'assistant-runs')) { this.directory = directory; }
  private path(id: string) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new Error('Invalid run ID.');
    return join(this.directory, `${id}.json`);
  }
  private save(record: RunRecord) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.id), temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); renameSync(temp, path);
  }
  create(prompt: string): RunRecord {
    const now = new Date().toISOString();
    const record: RunRecord = { id: randomUUID(), ownerPid: process.pid, state: 'queued', prompt, createdAt: now, updatedAt: now, events: [] };
    this.save(record); return record;
  }
  get(id: string): RunRecord | undefined {
    const path = this.path(id); if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
    if (data.id !== id || !Array.isArray(data.events) || !['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'].includes(data.state)) throw new Error('Run record is corrupt; it was not overwritten.');
    return data;
  }
  update(id: string, change: Partial<Pick<RunRecord, 'state' | 'model' | 'provider' | 'answer' | 'error'>>) {
    const run = this.get(id); if (!run) throw new Error('Run not found.');
    if (!ACTIVE.has(run.state) && change.state && change.state !== run.state) throw new Error('A finished run cannot be restarted or replayed.');
    Object.assign(run, change, { updatedAt: new Date().toISOString() }); this.save(run);
  }
  event(id: string, event: Record<string, unknown> & { type: string }) {
    // Stream deltas, screenshots and internal thinking are deliberately not persisted.
    if (['delta', 'response_start', 'answer', 'done', 'run'].includes(event.type)) return;
    const run = this.get(id); if (!run) throw new Error('Run not found.');
    const safe = JSON.parse(JSON.stringify(event)) as Record<string, unknown> & { type: string };
    delete safe.images; delete safe.thinking; delete safe.item;
    run.events = [...run.events.slice(-199), { ...safe, at: new Date().toISOString() }];
    run.updatedAt = new Date().toISOString(); this.save(run);
  }
  checkpoint(id: string, messages: ChatMessage[]) {
    const run = this.get(id); if (!run) throw new Error('Run not found.');
    // Diagnostic excerpts only. Omitting system memory, action arguments and screenshots
    // makes these unsuitable for replay; external actions must never be auto-reexecuted.
    run.checkpoint = messages.filter(m => m.role !== 'system').slice(-24).map(m => ({ role: m.role, tool_name: m.tool_name,
      content: m.tool_name?.startsWith('whatsapp_') || m.tool_name === 'read_project_file' ? '[Private tool content omitted]' : m.content.slice(0, 2400) }));
    run.updatedAt = new Date().toISOString(); this.save(run);
  }
  list(): RunRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => /^[a-f\d-]{36}\.json$/i.test(name)).flatMap(name => {
      try { const run = this.get(name.slice(0, -5)); return run ? [run] : []; } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  markInterrupted(): void {
    for (const run of this.list()) if (ACTIVE.has(run.state)) {
      if (run.ownerPid) { try { process.kill(run.ownerPid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; } }
      this.update(run.id, { state: 'interrupted', error: 'The server stopped before this run finished. Actions are not automatically replayed.' });
    }
  }
  remove(id: string): boolean {
    const run = this.get(id); if (!run) return false;
    if (ACTIVE.has(run.state)) throw new Error('Stop the active run before deleting it.');
    unlinkSync(this.path(id)); return true;
  }
}
