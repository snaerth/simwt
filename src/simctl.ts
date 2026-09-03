import { run, sleep } from './exec.ts'
import { fail } from './log.ts'

/**
 * `simctl` has no timeout of its own and a hung CoreSimulatorService takes the whole command
 * with it, so every call carries a budget sized to what it actually does.
 */
const TIMEOUTS = {
  list: 15_000,
  boot: 180_000,
  clone: 300_000,
  create: 120_000,
  install: 120_000,
  shutdown: 60_000,
  openurl: 30_000,
  short: 30_000,
} as const

export type Device = {
  udid: string
  name: string
  state: string
  runtime: string
  deviceTypeIdentifier: string
  isAvailable: boolean
  dataPathSize: number
  dataPath: string
  lastBootedAt: string | null
}

export type Runtime = {
  identifier: string
  version: string
  build: string
  imageUUID: string
  bundlePath: string
  state: string
  name: string
  sizeBytes: number
  lastUsedAt: string | null
  deletable: boolean
  unusableReason: string | null
}

type DeviceJson = {
  udid?: string
  name?: string
  state?: string
  deviceTypeIdentifier?: string
  isAvailable?: boolean
  dataPathSize?: number
  dataPath?: string
  lastBootedAt?: string
}

/**
 * The authoritative device source. Deliberately not `orca emulator devices`, which is a
 * projection that omits dataPathSize and lastBootedAt and makes the Orca CLI a hard dependency.
 */
export async function listDevices(): Promise<Device[]> {
  const result = await run('xcrun', ['simctl', 'list', 'devices', '--json'], {
    timeoutMs: TIMEOUTS.list,
  })

  if (result.exitCode !== 0) {
    fail(`Could not list simulators. ${result.stderr.trim()}`)
  }

  const parsed = JSON.parse(result.stdout) as { devices?: Record<string, DeviceJson[]> }
  const devices: Device[] = []

  for (const [runtime, entries] of Object.entries(parsed.devices ?? {})) {
    for (const entry of entries) {
      if (entry.udid === undefined || entry.name === undefined) {
        continue
      }

      devices.push({
        udid: entry.udid,
        name: entry.name,
        state: entry.state ?? 'Unknown',
        runtime,
        deviceTypeIdentifier: entry.deviceTypeIdentifier ?? '',
        isAvailable: entry.isAvailable ?? false,
        dataPathSize: entry.dataPathSize ?? 0,
        dataPath: entry.dataPath ?? '',
        lastBootedAt: entry.lastBootedAt ?? null,
      })
    }
  }

  return devices
}

export async function findDevice(udid: string): Promise<Device | null> {
  const devices = await listDevices()

  return devices.find((device) => device.udid === udid) ?? null
}

type RuntimeJson = {
  runtimeIdentifier?: string
  version?: string
  build?: string
  runtimeBundlePath?: string
  state?: string
  sizeBytes?: number
  lastUsedAt?: string
  deletable?: boolean
  unusableErrorMessage?: string
}

export async function listRuntimes(): Promise<Runtime[]> {
  const result = await run('xcrun', ['simctl', 'runtime', 'list', '-j'], {
    timeoutMs: TIMEOUTS.list,
  })

  if (result.exitCode !== 0) {
    return []
  }

  const parsed = JSON.parse(result.stdout) as Record<string, RuntimeJson>

  return Object.entries(parsed).map(([imageUUID, entry]) => ({
    imageUUID,
    identifier: entry.runtimeIdentifier ?? '',
    version: entry.version ?? '',
    build: entry.build ?? '',
    bundlePath: entry.runtimeBundlePath ?? '',
    state: entry.state ?? 'Unknown',
    name: `iOS ${entry.version ?? '?'} (${entry.build ?? '?'})`,
    sizeBytes: entry.sizeBytes ?? 0,
    lastUsedAt: entry.lastUsedAt ?? null,
    deletable: entry.deletable ?? false,
    unusableReason: entry.unusableErrorMessage ?? null,
  }))
}

/**
 * Clone and create both take a name, and `simctl` will happily make a second device with a name
 * that already exists rather than erroring. So the new UDID is never looked up by name, it is
 * whatever appeared in the device set that was not there a moment ago.
 */
async function captureNewDevice(action: () => Promise<{ exitCode: number; stderr: string }>) {
  const before = new Set((await listDevices()).map((device) => device.udid))
  const result = await action()

  if (result.exitCode !== 0) {
    return { udid: null, error: result.stderr.trim() }
  }

  const after = await listDevices()
  const created = after.find((device) => !before.has(device.udid))

  return created === undefined
    ? { udid: null, error: 'The clone reported success but no new device appeared' }
    : { udid: created.udid, error: null }
}

export function cloneDevice(sourceUdid: string, name: string) {
  return captureNewDevice(() =>
    run('xcrun', ['simctl', 'clone', sourceUdid, name], { timeoutMs: TIMEOUTS.clone }),
  )
}

/**
 * The runtime is addressed by its bundle path, never its identifier. Two Ready runtimes can
 * share one identifier (iOS 26.0 and 26.0.1 both report `SimRuntime.iOS-26-0`), and `simctl`
 * picks between them without saying which.
 */
export function createDevice(name: string, deviceTypeIdentifier: string, runtimeBundlePath: string) {
  return captureNewDevice(() =>
    run('xcrun', ['simctl', 'create', name, deviceTypeIdentifier, runtimeBundlePath], {
      timeoutMs: TIMEOUTS.create,
    }),
  )
}

export async function boot(udid: string) {
  const result = await run('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    timeoutMs: TIMEOUTS.boot,
  })

  // bootstatus exits non-zero when the device was already booted, which is not a failure.
  if (result.exitCode !== 0) {
    const device = await findDevice(udid)

    if (device?.state !== 'Booted') {
      fail(`The simulator did not boot. ${result.stderr.trim()}`)
    }
  }
}

/** Tolerates an already shut down device, which reports a non-zero exit. */
export async function shutdown(udid: string) {
  await run('xcrun', ['simctl', 'shutdown', udid], { timeoutMs: TIMEOUTS.shutdown })

  for (let attempt = 0; attempt < 30; attempt++) {
    const device = await findDevice(udid)

    if (device === null || device.state === 'Shutdown') {
      return
    }

    await sleep(1000)
  }
}

export async function deleteDevice(udid: string) {
  return run('xcrun', ['simctl', 'delete', udid], { timeoutMs: TIMEOUTS.short })
}

export async function installApp(udid: string, appPath: string) {
  return run('xcrun', ['simctl', 'install', udid, appPath], { timeoutMs: TIMEOUTS.install })
}

export async function appContainer(udid: string, bundleId: string, kind: 'app' | 'data' = 'app') {
  const result = await run('xcrun', ['simctl', 'get_app_container', udid, bundleId, kind], {
    timeoutMs: TIMEOUTS.short,
  })

  return result.exitCode === 0 ? result.stdout.trim() : null
}

export async function terminateApp(udid: string, bundleId: string) {
  return run('xcrun', ['simctl', 'terminate', udid, bundleId], { timeoutMs: TIMEOUTS.short })
}

export async function openUrl(udid: string, url: string) {
  return run('xcrun', ['simctl', 'openurl', udid, url], { timeoutMs: TIMEOUTS.openurl })
}
