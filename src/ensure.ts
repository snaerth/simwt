import { read, update } from './registry.ts'
import { resolveApp, type App } from './expoConfig.ts'
import { projectFingerprint } from './fingerprint.ts'
import { ensureApp, type EnsureResult } from './build.ts'
import { approveSchemes, disableAutoLaunch } from './devclient.ts'
import { findDevice, type Device } from './simctl.ts'
import { allocate } from './ports.ts'
import { fail, note, ok } from './log.ts'
import type { Context } from './context.ts'

export type Ready = { app: App; device: Device; port: number; outcome: EnsureResult }

export function simForWorktree(worktreePath: string) {
  const state = read()
  const found = Object.entries(state.sims).find(([, sim]) => sim.worktreePath === worktreePath)

  return found === undefined ? null : { udid: found[0], record: found[1] }
}

/**
 * Brings one app on this worktree's simulator to the current fingerprint and returns everything
 * the dev client step needs. Shared by `up`, which may build, and `warm`, which may not.
 */
export async function ensureReady(
  context: Context,
  appKey: string,
  options: { forceBuild: boolean; allowBuild: boolean },
): Promise<Ready | null> {
  const sim = simForWorktree(context.worktree.path)

  if (sim === null) {
    return fail('No simulator for this worktree. Run `simwt create`.')
  }

  const device = await findDevice(sim.udid)

  if (device === null) {
    return fail(`${sim.record.name} is recorded but gone. Run \`simwt create --force\`.`)
  }

  const app = await resolveApp(context.config, appKey, context.worktree.path)
  const fingerprint = await projectFingerprint(app.root)
  const installed = sim.record.apps[appKey]?.fingerprint ?? null

  const outcome = await ensureApp({
    udid: sim.udid,
    project: context.worktree.project,
    app,
    fingerprint,
    installedFingerprint: installed,
    forceBuild: options.forceBuild,
    allowBuild: options.allowBuild,
  })

  if (outcome === null) {
    note(`${app.key} has no cached build for ${fingerprint.slice(0, 12)}, so it was left alone.`)

    return null
  }

  if (outcome === 'current') {
    ok(`${app.key} is up to date (${fingerprint.slice(0, 12)})`)
  }

  if (outcome !== 'current') {
    // A fresh install wipes the container, so the launcher preference has to go back. The scheme
    // approval is device level and survived, but re-asserting it is free and covers a bare
    // simulator that never had a template.
    await disableAutoLaunch(sim.udid, app)
    await approveSchemes(device.dataPath, app.bundleId, app.schemes)
  }

  const port = await update((draft) => {
    const record = draft.sims[sim.udid]

    if (record === undefined) {
      return null
    }

    const assigned = allocate(draft, sim.udid, appKey)

    record.apps[appKey] = {
      port: assigned,
      fingerprint,
      metroTerminal: record.apps[appKey]?.metroTerminal ?? null,
      updatedAt: new Date().toISOString(),
    }
    record.heartbeatAt = new Date().toISOString()

    return assigned
  })

  if (port === null) {
    return fail('The simulator record disappeared while allocating a port')
  }

  return { app, device, port, outcome }
}
