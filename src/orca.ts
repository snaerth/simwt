import { run } from './exec.ts'

let available: boolean | null = null

/**
 * Every Orca call is a nicety. Device listing goes through simctl precisely so simwt keeps
 * working in a hook shell, in CI, or with Orca closed.
 */
export async function hasOrca() {
  if (available === null) {
    available = (await run('which', ['orca'], { timeoutMs: 5000 })).exitCode === 0
  }

  return available
}

async function orcaJson<T>(args: string[]): Promise<T | null> {
  if (!(await hasOrca())) {
    return null
  }

  const result = await run('orca', args, { timeoutMs: 20_000 })

  if (result.exitCode !== 0) {
    return null
  }

  try {
    const parsed = JSON.parse(result.stdout) as { ok?: boolean; result?: T }

    return parsed.ok === true ? (parsed.result ?? null) : null
  } catch {
    return null
  }
}

/**
 * Opens the mobile emulator tab in Orca and points it at this device.
 *
 * The worktree has to be named explicitly. A hook shell has no active worktree, so without it
 * Orca either picks the wrong one or attaches nowhere, and the simulator ends up running with no
 * window anywhere, which reads as nothing having happened.
 */
export async function attachPane(udid: string, worktreePath: string) {
  if (await hasOrca()) {
    await run(
      'orca',
      ['emulator', 'attach', udid, '--worktree', `path:${worktreePath}`, '--focus'],
      { timeoutMs: 60_000 },
    )
  }
}

export async function terminalCreate(title: string, command: string) {
  const created = await orcaJson<{ terminal?: { handle?: string }; handle?: string }>([
    'terminal',
    'create',
    '--worktree',
    'active',
    '--title',
    title,
    '--command',
    command,
    '--json',
  ])

  return created?.terminal?.handle ?? created?.handle ?? null
}

export async function terminalClose(handle: string) {
  if (await hasOrca()) {
    // Tolerate a stale handle, the tab may already be gone.
    await run('orca', ['terminal', 'close', '--terminal', handle, '--json'], { timeoutMs: 20_000 })
  }
}

export type OrcaWorktree = {
  path: string
  instanceId: string
  repoId: string
  isArchived: boolean
  isMainWorktree: boolean
}

/** Null rather than an empty list, so callers can tell "none" from "could not ask". */
export async function listWorktrees(): Promise<OrcaWorktree[] | null> {
  const listed = await orcaJson<{
    worktrees?: {
      path?: string
      instanceId?: string
      repoId?: string
      isArchived?: boolean
      isMainWorktree?: boolean
    }[]
  }>(['worktree', 'list', '--json'])

  if (listed?.worktrees === undefined) {
    return null
  }

  return listed.worktrees
    .filter((entry) => typeof entry.path === 'string')
    .map((entry) => ({
      path: entry.path!,
      instanceId: entry.instanceId ?? '',
      repoId: entry.repoId ?? '',
      isArchived: entry.isArchived ?? false,
      isMainWorktree: entry.isMainWorktree ?? false,
    }))
}
