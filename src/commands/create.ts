import { resolveContext } from '../context.ts'
import { read, update } from '../registry.ts'
import { pickTemplate, resolveRuntime } from '../template.ts'
import { simName } from '../naming.ts'
import {
  cloneDevice,
  createDevice,
  deleteDevice,
  listDevices,
  listRuntimes,
  shutdown,
} from '../simctl.ts'
import { note, ok, step, warn } from '../log.ts'
import { allocate } from '../ports.ts'

export type CreateOptions = { worktree?: string; device?: string; force: boolean }

function deviceTypeIdentifier(model: string) {
  return `com.apple.CoreSimulator.SimDeviceType.${model.trim().replace(/\s+/g, '-')}`
}

/**
 * The worktree setup hook. Stays fast, non interactive, and exits zero whatever happens, because
 * a failure here blocks worktree creation. It resolves no Expo config and needs no node_modules,
 * so the hook can run it before `bun install`.
 */
export async function create(options: CreateOptions) {
  const context = await resolveContext(options.worktree)

  if (context === null) {
    // Not an app repo. The same hook text is pasted everywhere, so this is a normal outcome.
    return
  }

  const { worktree, config } = context
  const model = options.device ?? config.device
  const name = simName(worktree.project, worktree.name, worktree.instanceId)
  const state = read()
  const devices = await listDevices()
  const recorded = Object.entries(state.sims).find(([, sim]) => sim.worktreePath === worktree.path)
  const recordedUdid = recorded?.[0]
  const alive = recordedUdid !== undefined && devices.some((device) => device.udid === recordedUdid)

  if (alive && !options.force) {
    ok(`${name} already exists`)

    return
  }

  // simctl happily creates a second device with a name that already exists, so anything left
  // over has to go before a new one is made or every later lookup is a coin flip.
  for (const stale of devices.filter((device) => device.name === name)) {
    step(`Removing the existing ${name}`)
    await shutdown(stale.udid)
    await deleteDevice(stale.udid)
  }

  if (recordedUdid !== undefined) {
    await update((draft) => {
      delete draft.sims[recordedUdid]
    })
  }

  const template = await pickTemplate(state, worktree.project, model)
  let udid: string | null = null
  let templateUdid: string | null = null

  if (template !== null) {
    step(`Cloning ${template.record.name}`)

    const cloned = await cloneDevice(template.udid, name)

    if (cloned.udid === null) {
      warn(`Could not clone the template. ${cloned.error}`)
    } else {
      udid = cloned.udid
      templateUdid = template.udid
    }
  }

  if (udid === null) {
    const runtime = resolveRuntime(await listRuntimes(), config.runtime)

    step(`No usable template, creating a bare ${model}`)

    const created = await createDevice(name, deviceTypeIdentifier(model), runtime.bundlePath)

    if (created.udid === null) {
      warn(`Could not create a simulator. ${created.error}`)

      return
    }

    udid = created.udid
    note('Run `simwt template bake` so future worktrees clone a warm simulator instead of a cold one.')
  }

  const now = new Date().toISOString()
  // A clone already carries whatever the template baked. Recording those fingerprints is what
  // stops the first `up` reinstalling an app that is byte for byte already there.
  const inherited: Record<string, { port: number; fingerprint: string | null; metroTerminal: null; updatedAt: string }> = {}

  if (template !== null && templateUdid !== null) {
    for (const [appKey, app] of Object.entries(template.record.apps)) {
      inherited[appKey] = { port: 0, fingerprint: app.fingerprint, metroTerminal: null, updatedAt: now }
    }
  }

  await update((draft) => {
    draft.sims[udid] = {
      name,
      project: worktree.project,
      worktreePath: worktree.path,
      worktreeName: worktree.name,
      instanceId: worktree.instanceId,
      templateUdid,
      createdAt: now,
      heartbeatAt: now,
      apps: {},
    }

    // Ports are handed out by `up`, so the inherited records start unassigned.
    for (const [appKey, record] of Object.entries(inherited)) {
      draft.sims[udid]!.apps[appKey] = { ...record, port: allocate(draft, udid, appKey) }
    }
  })

  ok(`${name} ready`)
}
