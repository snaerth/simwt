import { requireContext } from '../context.ts'
import { read, update } from '../registry.ts'
import { resolveRuntime, usableTemplates } from '../template.ts'
import { deviceTypeIdentifier, legacyTemplateName, templateName } from '../naming.ts'
import {
  boot,
  createDevice,
  deleteDevice,
  findDevice,
  listDevices,
  listRuntimes,
  shutdown,
} from '../simctl.ts'
import { resolveApp } from '../expoConfig.ts'
import { projectFingerprint } from '../fingerprint.ts'
import { ensureApp } from '../build.ts'
import { approveSchemes, disableAutoLaunch, readApprovedSchemes } from '../devclient.ts'
import { formatBytes } from '../disk.ts'
import { run } from '../exec.ts'
import { DIM, RESET, fail, log, note, ok, step, warn } from '../log.ts'
import { pruneDevice } from './gc.ts'

export type TemplateOptions = {
  action: 'bake' | 'list' | 'rm'
  worktree?: string
  device?: string
  runtime?: string
  name?: string
  apps?: string
}

async function bake(options: TemplateOptions) {
  const context = await requireContext(options.worktree)
  const { config, worktree } = context
  const model = options.device ?? config.device
  const runtime = resolveRuntime(
    await listRuntimes(),
    options.runtime ?? config.runtime,
    deviceTypeIdentifier(model),
  )
  const wanted = options.apps === undefined ? config.templateApps : options.apps.split(',')
  const bakeApps = wanted.map((key) => key.trim()).filter((key) => config.apps[key] !== undefined)

  if (bakeApps.length === 0) {
    return fail(`None of those apps exist here. This project has: ${Object.keys(config.apps).join(', ')}`)
  }
  const name = templateName(worktree.project, model, runtime.version, runtime.build)
  // Leftovers from before the name carried a project, plus the half baked device a failed bake
  // leaves behind. Only ever reclaimed when nothing in the registry still claims them.
  const legacy = legacyTemplateName(model, runtime.version, runtime.build)
  const recorded = read().templates

  step(`Baking ${name} for ${worktree.project}`)

  for (const stale of (await listDevices()).filter(
    (device) =>
      device.name === name ||
      (device.name === legacy && recorded[device.udid] === undefined),
  )) {
    step(`Removing the previous ${stale.name}`)
    await shutdown(stale.udid)
    await deleteDevice(stale.udid)

    await update((draft) => {
      delete draft.templates[stale.udid]
    })
  }

  const created = await createDevice(
    name,
    deviceTypeIdentifier(model),
    runtime.bundlePath,
  )

  if (created.udid === null) {
    return fail(`Could not create the template. ${created.error}`)
  }

  const udid = created.udid

  await boot(udid)

  const apps: Record<string, { bundleId: string; scheme: string; fingerprint: string }> = {}

  for (const appKey of bakeApps) {
    const app = await resolveApp(config, appKey, worktree.path)
    const fingerprint = await projectFingerprint(app.root)

    step(`Installing ${appKey} into the template`)

    await ensureApp({
      udid,
      project: worktree.project,
      app,
      fingerprint,
      installedFingerprint: null,
      forceBuild: false,
      allowBuild: true,
    })

    apps[appKey] = { bundleId: app.bundleId, scheme: app.scheme, fingerprint }
  }

  // Appearance and locale are cheapest to set while booted, and both live under data/ so they
  // survive the clone.
  await run('xcrun', ['simctl', 'ui', udid, 'appearance', 'light'])

  step('Shutting down to write the preferences safely')
  await shutdown(udid)

  const device = await findDevice(udid)

  if (device === null) {
    return fail('The template vanished mid bake')
  }

  for (const appKey of bakeApps) {
    const app = await resolveApp(config, appKey, worktree.path)

    await approveSchemes(device.dataPath, app.bundleId, app.schemes)
  }

  // The launcher preference lives in the app container and needs the device readable, which it
  // is while shut down.
  await boot(udid)

  for (const appKey of bakeApps) {
    const app = await resolveApp(config, appKey, worktree.path)

    await disableAutoLaunch(udid, app)
  }

  await shutdown(udid)

  const approved = await readApprovedSchemes(device.dataPath)
  const bakedSchemes = Object.values(apps).map((app) => app.scheme)
  const verified = bakedSchemes.every((scheme) =>
    Object.keys(approved).some((key) => key.endsWith(`-->${scheme}`)),
  )

  if (!verified) {
    warn('The scheme approval did not stick. The first deep link may show an "Open in ..." prompt.')
  }

  const pruned = pruneDevice(device.dataPath)
  const final = await findDevice(udid)

  await update((draft) => {
    draft.templates[udid] = {
      name,
      project: worktree.project,
      deviceTypeIdentifier: device.deviceTypeIdentifier,
      runtimeIdentifier: runtime.identifier,
      runtimeVersion: runtime.version,
      runtimeBuild: runtime.build,
      runtimeBundlePath: runtime.bundlePath,
      bakedAt: new Date().toISOString(),
      bakedBytes: final?.dataPathSize ?? 0,
      apps,
      schemeApprovalVerified: verified,
      driftCount: 0,
    }
  })

  ok(`${name} baked, ${formatBytes(final?.dataPathSize ?? 0)} after pruning ${pruned} cache entries`)
  note('New worktrees will clone this instead of creating a cold simulator.')
}

async function list() {
  const state = read()
  const usable = await usableTemplates(state)
  const usableUdids = new Set(usable.map((entry) => entry.udid))

  if (Object.keys(state.templates).length === 0) {
    log('No templates baked. Run `simwt template bake` in an app repo.')

    return
  }

  for (const [udid, template] of Object.entries(state.templates)) {
    const apps = Object.entries(template.apps)
      .map(([key, app]) => `${key}@${app.fingerprint.slice(0, 8)}`)
      .join(' ')

    log(
      `${usableUdids.has(udid) ? 'ok     ' : 'unusable'} ${template.name.padEnd(40)} ` +
        `${formatBytes(template.bakedBytes).padEnd(9)} ${DIM}${apps}${RESET}`,
    )
  }
}

async function remove(name: string | undefined) {
  if (name === undefined) {
    return fail('Pass the template name, as shown by `simwt template list`')
  }

  const state = read()
  const found = Object.entries(state.templates).find(([, template]) => template.name === name)

  if (found === undefined) {
    return fail(`No template called ${name}`)
  }

  await shutdown(found[0])
  await deleteDevice(found[0])
  await update((draft) => {
    delete draft.templates[found[0]]
  })

  ok(`Removed ${name}`)
}

export async function template(options: TemplateOptions) {
  if (options.action === 'bake') {
    return bake(options)
  }

  if (options.action === 'list') {
    return list()
  }

  return remove(options.name)
}
