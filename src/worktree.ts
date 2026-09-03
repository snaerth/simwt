import path from 'node:path'
import { createHash } from 'node:crypto'
import { run } from './exec.ts'
import { fail } from './log.ts'

export type Worktree = {
  /** Absolute path to the worktree root. */
  path: string
  /** Directory name, used for the readable half of the simulator name. */
  name: string
  /** The repo this worktree belongs to, shared by the primary checkout and every worktree. */
  project: string
  /** Stable per worktree identity. Orca's when it is available, otherwise derived from the path. */
  instanceId: string
}

async function git(args: string[], cwd: string) {
  const result = await run('git', args, { cwd, timeoutMs: 15_000 })

  return result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * The project name comes from the common git dir rather than the worktree path, so a worktree
 * and the primary checkout it was cut from resolve to the same project. That is what keeps
 * simulator names unique across repos, which `basename $PWD` alone does not.
 */
async function resolveProject(root: string) {
  const commonDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)

  if (commonDir === null) {
    return path.basename(root)
  }

  return path.basename(path.dirname(commonDir))
}

/**
 * A worktree path can look alive while being nothing of the sort. There is a directory on this
 * machine holding a single `apps/` folder from a half finished create, so existence is not the
 * test, git answering is.
 */
export async function isLiveWorktree(candidate: string) {
  return (await git(['rev-parse', '--show-toplevel'], candidate)) !== null
}

/**
 * The explicit flag first, since that is what the hooks pass and a hook shell has no meaningful
 * cwd. Then the working directory, because a terminal opened in one worktree keeps Orca's
 * environment even after you cd into another, and where you actually are is better evidence
 * than where the terminal started. Orca's variables are the fallback for a cwd outside any repo.
 */
export async function resolveWorktree(explicit?: string): Promise<Worktree> {
  const orcaId = process.env.ORCA_WORKTREE_ID
  const separator = orcaId === undefined ? -1 : orcaId.indexOf('::')
  const fromOrcaId = separator > -1 ? orcaId!.slice(separator + 2) : undefined

  const root =
    (explicit === undefined ? null : await git(['rev-parse', '--show-toplevel'], explicit)) ??
    explicit ??
    (await git(['rev-parse', '--show-toplevel'], process.cwd())) ??
    process.env.ORCA_WORKTREE_PATH ??
    fromOrcaId ??
    process.cwd()

  if (root.length === 0) {
    fail('Could not work out which worktree this is. Pass --worktree <path>.')
  }

  return {
    path: root,
    name: path.basename(root),
    project: await resolveProject(root),
    instanceId: await resolveInstanceId(root),
  }
}

/**
 * Orca mints a fresh id when a worktree is recreated under an old name, which is exactly the
 * property the simulator name needs. Without Orca the path hash is stable enough, since a
 * recreated worktree at the same path is the same worktree as far as anyone can tell.
 */
async function resolveInstanceId(root: string) {
  const listed = await run('orca', ['worktree', 'list', '--json'], { timeoutMs: 15_000 })

  if (listed.exitCode === 0) {
    try {
      const parsed = JSON.parse(listed.stdout) as {
        result?: { worktrees?: { path?: string; identity?: { instanceId?: string } }[] }
      }
      const match = parsed.result?.worktrees?.find((entry) => entry.path === root)
      const instanceId = match?.identity?.instanceId

      if (typeof instanceId === 'string' && instanceId.length > 0) {
        return instanceId
      }
    } catch {
      // Fall through to the path hash.
    }
  }

  return createHash('sha1').update(root).digest('hex').slice(0, 12)
}
