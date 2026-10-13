import { run } from './exec.ts'

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** Container free space, which is what actually limits a clone on APFS. */
export async function freeBytes() {
  const result = await run('/usr/sbin/diskutil', ['info', '-plist', '/'])

  if (result.exitCode !== 0) {
    return null
  }

  const match = result.stdout.match(/<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/)

  return match === null ? null : Number(match[1])
}

/** `du` rather than a walk, because these are build folders with hundreds of thousands of files. */
export async function dirBytes(target: string) {
  const measured = await run('du', ['-sk', target], { timeoutMs: 120_000 })
  const kb = Number.parseInt(measured.stdout.trim().split(/\s+/)[0] ?? '0', 10)

  return Number.isNaN(kb) ? 0 : kb * 1024
}
