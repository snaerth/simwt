import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { read, update } from '../registry.ts'
import { isSimwtSim } from '../naming.ts'
import { deleteDevice, listDevices, shutdown, type Device } from '../simctl.ts'
import { listWorktrees } from '../orca.ts'
import { isLiveWorktree } from '../worktree.ts'
import { isMetroUp } from '../ports.ts'
import { formatBytes } from '../disk.ts'
import { DIM, RESET, log, ok, warn } from '../log.ts'

export type SweepOptions = { apply: boolean; olderThanDays: number; includeIdle: boolean }

type Verdict = 'live' | 'orphan' | 'idle' | 'unknown'

type Candidate = { device: Device; verdict: Verdict; reason: string }

const HEARTBEAT_GRACE_MS = 30 * 60 * 1000

/**
 * Absence of evidence is not evidence of death. A simulator whose project is simply not visible
 * right now, because Orca is closed or a volume is not mounted, is reported as unknown and left
 * alone. Only positive evidence justifies deleting anything.
 */
async function classify(device: Device, olderThanDays: number): Promise<Candidate> {
  const state = read()
  const sim = state.sims[device.udid]
  const orcaWorktrees = await listWorktrees()

  if (sim === undefined) {
    return {
      device,
      verdict: 'unknown',
      reason: 'named like ours but not in the registry, so left alone',
    }
  }

  const orca = orcaWorktrees?.find((entry) => entry.path === sim.worktreePath)

  // Whether the worktree still exists is settled first. A simulator left running for a worktree
  // that has been archived is garbage that happens to be booted, and checking the boot state
  // before this is what let those pile up.
  if (orca?.isArchived === true) {
    return { device, verdict: 'orphan', reason: 'Orca reports the worktree archived' }
  }

  if (!(await isLiveWorktree(sim.worktreePath))) {
    // The path is not a git worktree. That is only proof of death if the project it belonged to
    // is still visible, otherwise the whole checkout may just be absent right now.
    if (orcaWorktrees === null) {
      return { device, verdict: 'unknown', reason: 'cannot reach Orca to confirm' }
    }

    return { device, verdict: 'orphan', reason: 'worktree no longer exists' }
  }

  // From here the worktree is alive, so the question is only whether someone is using it.
  if (device.state === 'Booted') {
    return { device, verdict: 'live', reason: 'booted' }
  }

  for (const app of Object.values(sim.apps)) {
    if (app.port !== null && (await isMetroUp(app.port))) {
      return { device, verdict: 'live', reason: `metro serving on ${app.port}` }
    }
  }

  if (Date.now() - Date.parse(sim.heartbeatAt) < HEARTBEAT_GRACE_MS) {
    return { device, verdict: 'live', reason: 'used in the last 30 minutes' }
  }

  const lastBooted = device.lastBootedAt === null ? 0 : Date.parse(device.lastBootedAt)
  const idleDays = lastBooted === 0 ? Infinity : (Date.now() - lastBooted) / 86_400_000

  if (idleDays >= olderThanDays) {
    return {
      device,
      verdict: 'idle',
      reason: `worktree is live but the simulator has not booted in ${Math.round(idleDays)}d`,
    }
  }

  return { device, verdict: 'live', reason: 'worktree is a live git checkout' }
}

export async function sweep(options: SweepOptions) {
  const devices = await listDevices()
  // The prefix is the fence. Nothing without it is ever a candidate, which is what keeps a
  // daily driver holding gigabytes of signed in state out of reach.
  const ours = devices.filter((device) => isSimwtSim(device.name))
  const candidates: Candidate[] = []

  for (const device of ours) {
    candidates.push(await classify(device, options.olderThanDays))
  }

  const idle = candidates.filter((candidate) => candidate.verdict === 'idle')
  const orphans = candidates.filter(
    (candidate) =>
      candidate.verdict === 'orphan' || (options.includeIdle && candidate.verdict === 'idle'),
  )
  const reclaimable = orphans.reduce((total, candidate) => total + candidate.device.dataPathSize, 0)

  for (const candidate of candidates) {
    log(
      `${candidate.verdict.padEnd(8)} ${candidate.device.name.padEnd(44)} ` +
        `${formatBytes(candidate.device.dataPathSize).padEnd(9)} ${DIM}${candidate.reason}${RESET}`,
    )
  }

  // Registry entries whose device is gone cost nothing to hold but make status lie.
  const state = read()
  const stale = Object.keys(state.sims).filter(
    (udid) => !devices.some((device) => device.udid === udid),
  )

  if (orphans.length === 0 && stale.length === 0) {
    log('Nothing to reclaim')

    return
  }

  if (!options.apply) {
    log('')
    log(
      `Would remove ${orphans.length} simulator(s) and ${stale.length} stale record(s), reclaiming ${formatBytes(reclaimable)}.`,
    )
    log('Re-run with --apply to do it.')

    if (!options.includeIdle && idle.length > 0) {
      const idleBytes = idle.reduce((total, entry) => total + entry.device.dataPathSize, 0)

      log(
        `${idle.length} more belong to live worktrees but have sat unused, holding ${formatBytes(idleBytes)}. --include-idle removes those too; they re-clone in seconds.`,
      )
    }

    return
  }

  for (const candidate of orphans) {
    await shutdown(candidate.device.udid)

    const deleted = await deleteDevice(candidate.device.udid)

    if (deleted.exitCode !== 0) {
      warn(`Could not delete ${candidate.device.name}. ${deleted.stderr.trim()}`)
      continue
    }

    fs.rmSync(path.join(os.homedir(), 'Library', 'Logs', 'CoreSimulator', candidate.device.udid), {
      recursive: true,
      force: true,
    })

    await update((draft) => {
      delete draft.sims[candidate.device.udid]
    })

    ok(`Removed ${candidate.device.name}`)
  }

  if (stale.length > 0) {
    await update((draft) => {
      for (const udid of stale) {
        delete draft.sims[udid]
      }
    })

    ok(`Dropped ${stale.length} stale record(s)`)
  }
}
