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
 * Prefer a template that already carries this project's apps, then the newest runtime, then the
 * most recently baked. Never guess across projects when a project-specific one exists.
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

  const scored = candidates
    .filter((candidate) =>
      deviceHint === null
        ? true
        : shortDeviceType(candidate.record.deviceTypeIdentifier).toLowerCase() ===
          deviceHint.toLowerCase().replace(/\s+/g, '-'),
    )
    .sort((a, b) => {
      const projectRank =
        Number(b.record.project === project) - Number(a.record.project === project)

      if (projectRank !== 0) {
        return projectRank
      }

      const version = compareVersions(b.record.runtimeVersion, a.record.runtimeVersion)

      if (version !== 0) {
        return version
      }

      return b.record.bakedAt.localeCompare(a.record.bakedAt)
    })

  return scored[0] ?? candidates[0] ?? null
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
export function resolveRuntime(runtimes: Runtime[], pin: string | null): Runtime {
  const ready = runtimes.filter((runtime) => runtime.state === 'Ready')

  if (ready.length === 0) {
    return fail('No usable iOS simulator runtime is installed')
  }

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

    return matches[0]!
  }

  const newest = [...ready].sort((a, b) => compareVersions(b.version, a.version))
  const best = newest[0]!
  const tied = newest.filter((runtime) => runtime.version === best.version)

  if (tied.length > 1) {
    return fail(
      `Several Ready runtimes are on ${best.version} (${tied.map((r) => r.build).join(', ')}). Set "runtime" in simwt.json.`,
    )
  }

  return best
}

export async function findTemplateDevices() {
  return (await listDevices()).filter((device) => isSimwtTemplate(device.name))
}
