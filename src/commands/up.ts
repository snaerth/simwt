import { requireContext } from '../context.ts'
import { resolveAppKey } from '../config.ts'
import { ensureReady, simForWorktree } from '../ensure.ts'
import { boot, findDevice } from '../simctl.ts'
import { isMetroUp } from '../ports.ts'
import { pointDevClient } from '../devclient.ts'
import { runMetroHere, startMetroInTab } from '../metro.ts'
import { attachPane } from '../orca.ts'
import { update } from '../registry.ts'
import { evictCache } from '../build.ts'
import { read } from '../registry.ts'
import { ok, step } from '../log.ts'
import { create } from './create.ts'

export type UpOptions = {
  app?: string
  worktree?: string
  build: boolean
  detached: boolean
  noMetro: boolean
}

/** Fingerprints that something still depends on are never evicted from the build cache. */
function pinnedFingerprints() {
  const state = read()
  const pinned = new Set<string>()

  for (const sim of Object.values(state.sims)) {
    for (const app of Object.values(sim.apps)) {
      if (app.fingerprint !== null) {
        pinned.add(app.fingerprint)
      }
    }
  }

  for (const template of Object.values(state.templates)) {
    for (const app of Object.values(template.apps)) {
      pinned.add(app.fingerprint)
    }
  }

  return pinned
}

export async function up(options: UpOptions) {
  const context = await requireContext(options.worktree)
  const appKey = resolveAppKey(context.config, options.app)

  if (simForWorktree(context.worktree.path) === null) {
    await create({ worktree: options.worktree, force: false })
  }

  const sim = simForWorktree(context.worktree.path)

  if (sim !== null) {
    const device = await findDevice(sim.udid)

    if (device?.state !== 'Booted') {
      step(`Booting ${sim.record.name}`)
      await boot(sim.udid)
    }
  }

  const ready = await ensureReady(context, appKey, {
    forceBuild: options.build,
    allowBuild: true,
  })

  if (ready === null) {
    return
  }

  const { app, device, port } = ready

  if (options.noMetro) {
    await pointDevClient(app, device, port)

    return
  }

  // Re-running while Metro is already serving is a no op that returns in seconds.
  if (await isMetroUp(port)) {
    ok(`Metro is already serving ${app.key} on ${port}`)
    await pointDevClient(app, device, port)
    await attachPane(device.udid, context.worktree.path)

    return
  }

  const attach = async () => {
    await pointDevClient(app, device, port)
    await attachPane(device.udid, context.worktree.path)
  }

  if (options.detached) {
    const recorded = sim === null ? null : (sim.record.apps[appKey]?.metroTerminal ?? null)
    const handle = await startMetroInTab(app, port, recorded)

    await update((draft) => {
      const record = draft.sims[device.udid]
      const entry = record?.apps[appKey]

      if (entry !== undefined) {
        entry.metroTerminal = handle
      }
    })

    await attach()
  } else {
    await runMetroHere(app, port, attach)
  }

  evictCache(pinnedFingerprints())
}
