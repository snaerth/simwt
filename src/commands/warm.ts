import { resolveContext } from '../context.ts'
import { ensureReady, simForWorktree } from '../ensure.ts'
import { boot, findDevice } from '../simctl.ts'
import { attachPane } from '../orca.ts'
import { isMetroUp } from '../ports.ts'
import { startMetroInTab } from '../metro.ts'
import { pointDevClient } from '../devclient.ts'
import { update } from '../registry.ts'
import { note, ok, warn } from '../log.ts'

export type WarmOptions = { worktree?: string; budgetSeconds: number; launch: boolean }

/**
 * The second half of the worktree setup hook. Boots the simulator, shows it in Orca, installs
 * whatever the build cache already has and, unless told not to, starts Metro in its own tab and
 * opens the app on it.
 *
 * It never builds. Orca kills a hook at two minutes and a native build takes minutes, so a cache
 * miss has to end as a note rather than a stall.
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

  // Without this the simulator runs with no window in Orca, which reads as nothing having
  // happened at all.
  await attachPane(sim.udid, context.worktree.path)

  for (const appKey of context.config.warmOnCreate) {
    if (context.config.apps[appKey] === undefined) {
      continue
    }

    if (Date.now() > deadline) {
      note(`Out of the ${options.budgetSeconds}s budget, so ${appKey} was left for \`simwt up\`.`)

      return
    }

    const ready = await ensureReady(context, appKey, { forceBuild: false, allowBuild: false })

    if (ready === null) {
      warn(`No cached build for ${appKey}. Run \`simwt up\` in the worktree to build it once.`)
      continue
    }

    ok(`${appKey} is installed`)

    if (!options.launch) {
      continue
    }

    if (Date.now() > deadline) {
      note(`Out of the ${options.budgetSeconds}s budget, so Metro was left for \`simwt up\`.`)

      return
    }

    await startApp(ready.app, ready.device, ready.port, appKey)
  }
}

/**
 * Metro gets its own Orca tab rather than the hook's shell, which dies with the hook. The tab is
 * also where the logs are, so it has to outlive us.
 */
async function startApp(
  app: Parameters<typeof pointDevClient>[0],
  device: Parameters<typeof pointDevClient>[1],
  port: number,
  appKey: string,
) {
  if (!(await isMetroUp(port))) {
    const handle = await startMetroInTab(app, port, null).catch(() => null)

    if (handle === null) {
      warn(`Could not start Metro for ${appKey}. Run \`simwt up\` in the worktree.`)

      return
    }

    await update((draft) => {
      const entry = draft.sims[device.udid]?.apps[appKey]

      if (entry !== undefined) {
        entry.metroTerminal = handle
      }
    })
  }

  await pointDevClient(app, device, port)
}
