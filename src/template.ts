import { listDevices, listRuntimes, type Device, type Runtime } from './simctl.ts'
import { isSimwtTemplate, shortDeviceType } from './naming.ts'
import type { State, TemplateRecord } from './registry.ts'
import { fail } from './log.ts'

export type ResolvedTemplate = { udid: string; record: TemplateRecord; device: Device }

/**
 * A template is only usable if the device is still there and its runtime is still Ready. Both
 * fail in practice: an Xcode update can leave a runtime registered but Unusable, and someone can
 * delete the device in Simulator.app.
 */
export async function usableTemplates(state: State): Promise<ResolvedTemplate[]> {
  const devices = await listDevices()
  const runtimes = await listRuntimes()
  const readyBuilds = new Set(
    runtimes.filter((runtime) => runtime.state === 'Ready').map((runtime) => runtime.build),
  )
  const resolved: ResolvedTemplate[] = []

  for (const [udid, record] of Object.entries(state.templates)) {
    const device = devices.find((candidate) => candidate.udid === udid)

    if (device === undefined || !device.isAvailable) {
      continue
    }

    if (!readyBuilds.has(record.runtimeBuild)) {
      continue
    }

    resolved.push({ udid, record, device })
  }

  return resolved
}

/**
 * Only ever a template baked for this project. Another project's template carries the wrong app
 * and the wrong scheme approvals, so cloning it is strictly worse than starting from a bare
 * simulator, and it silently attributes that project's apps to this worktree.
 */
export async function pickTemplate(
  state: State,
  project: string,
  deviceHint: string | null,
): Promise<ResolvedTemplate | null> {
  const candidates = await usableTemplates(state)

  if (candidates.length === 0) {
    return null
  }

  const mine = candidates.filter((candidate) => candidate.record.project === project)

  if (mine.length === 0) {
    return null
  }

  const preferred = mine.filter((candidate) =>
    deviceHint === null
      ? true
      : shortDeviceType(candidate.record.deviceTypeIdentifier).toLowerCase() ===
        deviceHint.toLowerCase().replace(/\s+/g, '-'),
  )
  const scored = (preferred.length > 0 ? preferred : mine).sort((a, b) => {
    const version = compareVersions(b.record.runtimeVersion, a.record.runtimeVersion)

    return version !== 0 ? version : b.record.bakedAt.localeCompare(a.record.bakedAt)
  })

  return scored[0] ?? null
}

function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)

    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

/**
 * Resolves the runtime by version and build rather than identifier. Two Ready runtimes can share
 * one identifier, so `simctl create` given only the identifier picks between them silently.
 */
export function resolveRuntime(runtimes: Runtime[], pin: string | null, deviceType: string): Runtime {
  const ready = runtimes.filter((runtime) => runtime.state === 'Ready')

  if (ready.length === 0) {
    return fail('No usable iOS simulator runtime is installed')
  }

  const model = shortDeviceType(deviceType)

  if (pin !== null) {
    const [version, build] = pin.split('/')
    const matches = ready.filter(
      (runtime) =>
        runtime.version === version && (build === undefined || runtime.build === build),
    )

    if (matches.length === 0) {
      return fail(
        `No Ready runtime matches "${pin}". Available: ${ready.map((r) => `${r.version}/${r.build}`).join(', ')}`,
      )
    }

    if (matches.length > 1) {
      return fail(
        `"${pin}" is ambiguous, it matches ${matches.map((r) => `${r.version}/${r.build}`).join(' and ')}. Pin the build too.`,
      )
    }

    const pinned = matches[0]!

    if (!supports(pinned, deviceType)) {
      return fail(`Runtime ${pinned.version}/${pinned.build} has no ${model} simulator.`)
    }

    return pinned
  }

  const fitting = ready.filter((runtime) => supports(runtime, deviceType))

  if (fitting.length === 0) {
    return fail(
      `No Ready runtime has a ${model} simulator. Available: ${ready.map((r) => `${r.version}/${r.build}`).join(', ')}`,
    )
  }

  const newest = [...fitting].sort((a, b) => compareVersions(b.version, a.version))
  const best = newest[0]!
  const tied = newest.filter((runtime) => runtime.version === best.version)

  if (tied.length > 1) {
    return fail(
      `Several Ready runtimes are on ${best.version} (${tied.map((r) => r.build).join(', ')}). Set "runtime" in simwt.json.`,
    )
  }

  return best
}

function supports(runtime: Runtime, deviceType: string) {
  return runtime.deviceTypes === null || runtime.deviceTypes.includes(deviceType)
}

export async function findTemplateDevices() {
  return (await listDevices()).filter((device) => isSimwtTemplate(device.name))
}
