import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

const realpathOr = async (p: string): Promise<string> => {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
};

/**
 * Resolve `target` against `repoRoot` **following symlinks**, returning its real
 * absolute path only if it stays inside the repo tree — otherwise `null`. A
 * lexical check (`resolve` + prefix) is not enough: `fs` follows symlinks, so an
 * in-repo symlink (or a `..` target) can land outside `repoRoot`. For a file
 * that does not exist yet, the real path of its nearest existing ancestor is
 * used, so a write cannot be redirected out of the tree through a symlinked dir.
 */
export async function realContainedPath(repoRoot: string, target: string): Promise<string | null> {
  const realRepo = await realpathOr(resolve(repoRoot));
  const abs = resolve(realRepo, target);
  let real: string;
  try {
    real = await realpath(abs); // path exists — resolve it fully
  } catch {
    real = resolve(await realpathOr(dirname(abs)), basename(abs)); // new file — resolve its parent
  }
  return real === realRepo || real.startsWith(realRepo + sep) ? real : null;
}
