import type { Verdict } from '../core/types';
import { notImplemented } from '../core/result';

/** Runs build / test / lint and returns a pass/fail verdict per check. */
export class Verifier {
  async verify(_files: string[]): Promise<Verdict> {
    return notImplemented('Verifier.verify', 'M6');
  }
}
