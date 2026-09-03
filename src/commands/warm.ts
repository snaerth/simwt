import { resolveContext } from '../context.ts'
import { ensureReady, simForWorktree } from '../ensure.ts'
import { boot, findDevice } from '../simctl.ts'
import { note, ok } from '../log.ts'

export type WarmOptions = { worktree?: string; budgetSeconds: number }

/**
 * The second half of the worktree setup hook. Boots the simulator and installs whatever the
 * build cache already has, so a new worktree is usable immediately.
 *
 * It deliberately never builds. Orca kills a hook at two minutes, and a native build takes
 * minutes, so a cache miss has to end as a note rather than a stall.
 */
export async function warm(options: WarmOptions) {
  const context = await resolveContext(options.worktree)

  if (context === null) {
    return
  }

  const sim = simForWorktree(context.worktree.path)

  if (sim === null) {
    return
  }

  const deadline = Date.now() + options.budgetSeconds * 1000
  const device = await findDevice(sim.udid)

  if (device === null) {
    return
  }

  if (device.state !== 'Booted') {
    await boot(sim.udid)
  }

  for (const appKey of context.config.warmOnCreate) {
    if (Date.now() > deadline) {
      note(`Ran out of the ${options.budgetSeconds}s budget, so ${appKey} was left for \`simwt up\`.`)

      return
    }

    if (context.config.apps[appKey] === undefined) {
      continue
    }

    const ready = await ensureReady(context, appKey, { forceBuild: false, allowBuild: false })

    if (ready !== null) {
      ok(`${appKey} is installed and ready`)
    }
  }
}
