import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { read, update } from '../registry.ts'
import { resolveWorktree } from '../worktree.ts'
import { deleteDevice, listDevices, shutdown } from '../simctl.ts'
import { terminalClose } from '../orca.ts'
import { buildsUnder, listDerivedBuilds, removeBuild } from '../derivedData.ts'
import { formatBytes } from '../disk.ts'
import { ok, warn } from '../log.ts'

export type DestroyOptions = { worktree?: string }

/**
 * `simctl delete` leaves both of these behind, and at one simulator per worktree they pile up
 * fast. There are already orphaned log directories and stale DevicePreferences entries on this
 * machine from sims deleted long ago.
 */
async function cleanUpAfterDelete(udid: string) {
  fs.rmSync(path.join(os.homedir(), 'Library', 'Logs', 'CoreSimulator', udid), {
    recursive: true,
    force: true,
  })
}

/**
 * The simulator is the small half. Xcode's build folder for this worktree is several gigabytes
 * and outlives the checkout, so a worktree archived without this leaves more behind than it took.
 */
async function reclaimDerivedData(worktreePath: string) {
  const builds = buildsUnder(await listDerivedBuilds(), worktreePath)

  if (builds.length === 0) {
    return
  }

  for (const build of builds) {
    removeBuild(build)
  }

  ok(
    `Removed ${builds.length} Xcode build folder(s), ` +
      `${formatBytes(builds.reduce((total, build) => total + build.bytes, 0))}`,
  )
}

/**
 * The worktree archive hook. Driven by the explicit path, because the hook runs before the
 * archive so the directory still exists and "is it gone" is not yet a usable signal. Always
 * exits zero, since a simctl hiccup must never block an archive.
 */
export async function destroy(options: DestroyOptions) {
  const worktree = await resolveWorktree(options.worktree)
  const state = read()
  const entries = Object.entries(state.sims).filter(
    ([, sim]) => sim.worktreePath === worktree.path,
  )

  const devices = await listDevices()

  for (const [udid, sim] of entries) {
    for (const app of Object.values(sim.apps)) {
      if (app.metroTerminal !== null) {
        await terminalClose(app.metroTerminal)
      }
    }

    if (devices.some((device) => device.udid === udid)) {
      await shutdown(udid)

      const deleted = await deleteDevice(udid)

      if (deleted.exitCode !== 0) {
        warn(`Could not delete ${sim.name}. ${deleted.stderr.trim()}`)
        continue
      }
    }

    await cleanUpAfterDelete(udid)

    await update((draft) => {
      delete draft.sims[udid]
    })

    ok(`Removed ${sim.name}`)
  }

  await reclaimDerivedData(worktree.path)
}
