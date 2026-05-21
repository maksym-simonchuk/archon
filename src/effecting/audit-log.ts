import type { JournalEntry } from '../core/types';

/**
 * Append-only, in-memory record of every decision / diff / cost (ADR-0010).
 * Entries are never mutated and carry a monotonically increasing `seq`. Durable
 * on-disk persistence is layered on later and must route through the broker, so
 * the "only the broker touches the filesystem" invariant stays intact.
 */
export class AuditLog {
  private readonly log: JournalEntry[] = [];
  private nextSeq = 0;

  /** Append an entry; `seq` is assigned here. Returns the stored entry. */
  append(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
    const stored: JournalEntry = { ...entry, seq: this.nextSeq++ };
    this.log.push(stored);
    return stored;
  }

  /** Read-only view of every entry, in append order. */
  entries(): readonly JournalEntry[] {
    return this.log;
  }
}
