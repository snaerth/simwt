import fs from 'node:fs'
import path from 'node:path'
import { listDevices, type Device } from '../simctl.ts'
import { isSimwtSim, isSimwtTemplate } from '../naming.ts'
import { formatBytes, freeBytes } from '../disk.ts'
import { DIM, RESET, log, ok, warn } from '../log.ts'

export type GcOptions = { apply: boolean; all: boolean }

/**
 * Caches and log archives a booted simulator regenerates on demand. On a device that has seen a
 * few months of use these are most of its size. `private/var/MobileAsset` is deliberately absent,
 * it is the first boot cost and removing it just makes the next boot pay again.
 */
export const PRUNABLE = [
  'var/db/diagnostics',
  'var/db/uuidtext',
  'Library/Caches/com.apple.coresymbolicationd',
  'Library/Caches/com.apple.mediaanalysisd',
  'Library/News',
  'tmp',
]

function directorySize(target: string) {
  let total = 0

  const walk = (dir: string) => {
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      try {
        if (entry.isDirectory()) {
          walk(full)
        } else {
          total += fs.statSync(full).size
        }
      } catch {
        // Racing with the simulator is fine, this is only an estimate.
      }
    }
  }

  walk(target)

  return total
}

function prunableBytes(dataPath: string) {
  return PRUNABLE.map((relative) => directorySize(path.join(dataPath, relative))).reduce(
    (sum, bytes) => sum + bytes,
    0,
  )
}

export function pruneDevice(dataPath: string) {
  let removed = 0

  for (const relative of PRUNABLE) {
    const target = path.join(dataPath, relative)

    if (!fs.existsSync(target)) {
      continue
    }

    for (const entry of fs.readdirSync(target)) {
      try {
        fs.rmSync(path.join(target, entry), { recursive: true, force: true })
        removed += 1
      } catch {
        // A cache we cannot remove is not worth failing over.
      }
    }
  }

  return removed
}

/**
 * Shrinks simulators in place rather than deleting them. Only shut down devices are touched,
 * since pruning under a running simulator is asking for trouble, and by default only ones simwt
 * made. `--all` opts in to every shut down simulator on the machine, which is where the real
 * space usually is.
 */
export async function gc(options: GcOptions) {
  const devices = await listDevices()
  const targets = devices.filter((device) => {
    if (device.state !== 'Shutdown' || device.dataPath.length === 0) {
      return false
    }

    return options.all ? !isSimwtTemplate(device.name) : isSimwtSim(device.name)
  })

  if (targets.length === 0) {
    log(
      options.all
        ? 'No shut down simulators to prune'
        : 'No simwt simulators to prune. Use --all to include your own simulators.',
    )

    return
  }

  const plan: { device: Device; bytes: number }[] = []

  for (const device of targets) {
    plan.push({ device, bytes: prunableBytes(device.dataPath) })
  }

  const worthwhile = plan.filter((entry) => entry.bytes > 10 * 1024 * 1024)
  const total = worthwhile.reduce((sum, entry) => sum + entry.bytes, 0)

  for (const entry of worthwhile) {
    log(
      `${formatBytes(entry.bytes).padStart(9)}  ${entry.device.name.padEnd(40)} ` +
        `${DIM}of ${formatBytes(entry.device.dataPathSize)}${RESET}`,
    )
  }

  if (worthwhile.length === 0) {
    log('Nothing worth pruning')

    return
  }

  if (!options.apply) {
    log('')
    log(`Would reclaim about ${formatBytes(total)}. Re-run with --apply to do it.`)

    return
  }

  const before = await freeBytes()

  for (const entry of worthwhile) {
    const removed = pruneDevice(entry.device.dataPath)

    ok(`Pruned ${removed} cache entries from ${entry.device.name}`)
  }

  const after = await freeBytes()

  if (before !== null && after !== null) {
    const freed = after - before

    if (freed > 0) {
      ok(`Reclaimed ${formatBytes(freed)}`)
    } else {
      warn('Free space did not move, the caches may already have been purgeable')
    }
  }
}
