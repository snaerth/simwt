import { read, update } from '../registry.ts'
import { resolveWorktree } from '../worktree.ts'
import { terminalClose } from '../orca.ts'
import { isMetroUp } from '../ports.ts'
import { log, ok, warn } from '../log.ts'

export type DownOptions = { app?: string; worktree?: string }

/**
 * Stops this worktree's detached Metro tabs. The simulator is left alone, since `down` is about
 * freeing a port and a tab rather than giving up the device.
 */
export async function down(options: DownOptions) {
  const worktree = await resolveWorktree(options.worktree)
  const state = read()
  const entries = Object.entries(state.sims).filter(
    ([, sim]) => sim.worktreePath === worktree.path,
  )

  if (entries.length === 0) {
    log('Nothing recorded for this worktree')

    return
  }

  for (const [udid, sim] of entries) {
    for (const [appKey, app] of Object.entries(sim.apps)) {
      if (options.app !== undefined && appKey !== options.app) {
        continue
      }

      if (app.metroTerminal !== null) {
        await terminalClose(app.metroTerminal)

        await update((draft) => {
          const entry = draft.sims[udid]?.apps[appKey]

          if (entry !== undefined) {
            entry.metroTerminal = null
          }
        })

        ok(`Closed the Metro tab for ${appKey} on ${app.port}`)
        continue
      }

      if (await isMetroUp(app.port)) {
        // A foreground Metro owns someone's terminal, so it is theirs to stop.
        warn(`Metro for ${appKey} is running on ${app.port} in a terminal. Press Ctrl+C there.`)
      }
    }
  }
}
