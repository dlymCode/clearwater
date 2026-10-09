import { bySeq, type OutboxRow, type OutboxStatus, type OutboxStore } from './outbox';
import type { OutboxKind } from '@clearwater/shared';

/** In-memory OutboxStore for tests (and as a reference for the SQLite implementation). */
export class InMemoryOutboxStore implements OutboxStore {
  private rows = new Map<string, OutboxRow>();
  private seq = 0;

  async nextSeq(): Promise<number> {
    this.seq += 1;
    return this.seq;
  }

  async insert(row: OutboxRow): Promise<void> {
    if (this.rows.has(row.id)) throw new Error(`duplicate outbox id ${row.id}`);
    this.rows.set(row.id, { ...row });
  }

  async get(id: string): Promise<OutboxRow | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  async list(filter: { status?: OutboxStatus; kind?: OutboxKind } = {}): Promise<OutboxRow[]> {
    return [...this.rows.values()]
      .filter((r) => (!filter.status || r.status === filter.status) && (!filter.kind || r.kind === filter.kind))
      .sort(bySeq)
      .map((r) => ({ ...r }));
  }

  async update(
    id: string,
    patch: Partial<Pick<OutboxRow, 'status' | 'attempts' | 'lastError' | 'payload' | 'bytes'>>,
  ): Promise<void> {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no outbox row ${id}`);
    this.rows.set(id, { ...r, ...patch });
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }

  async atomic<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
