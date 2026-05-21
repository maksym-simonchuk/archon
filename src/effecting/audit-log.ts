import type { JournalEntry } from '../core/types';
import { notImplemented } from '../core/result';

/** Append-only record of every decision, diff, and cost. Never mutated. */
export class AuditLog {
  append(_entry: JournalEntry): void {
    return notImplemented('AuditLog.append', 'M3');
  }
}
