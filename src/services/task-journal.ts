import type { JournalEntry } from '../core/types';
import { notImplemented } from '../core/result';

/**
 * Append-only, durable log of every task (plan/step/decision/diff/verdict/cost).
 * Source of truth for crash-resume and audit. Single-process now; a multi-process
 * deployment reads the identical log with no redesign. See ARCHITECTURE.md.
 */
export class TaskJournal {
  append(_entry: JournalEntry): void {
    return notImplemented('TaskJournal.append', 'M0');
  }

  async replay(_taskId: string): Promise<JournalEntry[]> {
    return notImplemented('TaskJournal.replay', 'M0');
  }
}
