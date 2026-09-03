import { read } from '../registry.ts'
import { resolveWorktree } from '../worktree.ts'
import { listDevices } from '../simctl.ts'
import { isMetroUp } from '../ports.ts'
import { formatBytes, freeBytes } from '../disk.ts'
import { DIM, GREEN, RESET, log, warn } from '../log.ts'

export type StatusOptions = { worktree?: string; json: boolean }

type Row = {
  current: boolean
  project: string
  worktree: string
  app: string
  sim: string
  state: string
  size: number
  port: number | null
  metro: boolean
}

export async function status(options: StatusOptions) {
  const state = read()
  const devices = await listDevices()
  const here = (await resolveWorktree(options.worktree)).path
  const rows: Row[] = []

  for (const [udid, sim] of Object.entries(state.sims)) {
    const device = devices.find((candidate) => candidate.udid === udid)
    const base = {
      current: sim.worktreePath === here,
      project: sim.project,
      worktree: sim.worktreeName,
      sim: sim.name,
      state: device?.state ?? 'missing',
      size: device?.dataPathSize ?? 0,
    }
    const apps = Object.entries(sim.apps)

    if (apps.length === 0) {
      rows.push({ ...base, app: '-', port: null, metro: false })
      continue
    }

    for (const [appKey, app] of apps) {
      rows.push({
        ...base,
        app: appKey,
        port: app.port,
        metro: app.port !== null && (await isMetroUp(app.port)),
      })
    }
  }

  if (options.json) {
    log(JSON.stringify({ sims: rows, templates: state.templates }, null, 2))

    return
  }

  if (rows.length === 0) {
    log('No simulators recorded. Run `simwt create` in a worktree.')
  }

  for (const row of rows) {
    const marker = row.current ? `${GREEN}*${RESET}` : ' '

    log(
      `${marker} ${row.worktree.padEnd(24)} ${row.app.padEnd(10)} ${row.state.padEnd(9)} ` +
        `${String(row.port ?? '-').padEnd(6)} ${(row.metro ? 'metro up' : row.port === null ? 'not run' : 'metro down').padEnd(11)} ` +
        `${DIM}${formatBytes(row.size)}${RESET}`,
    )
  }

  for (const [udid, template] of Object.entries(state.templates)) {
    const device = devices.find((candidate) => candidate.udid === udid)

    log(
      `${DIM}  template ${template.name} (${template.project}) ` +
        `${device === undefined ? 'MISSING' : device.state} ${formatBytes(template.bakedBytes)}${RESET}`,
    )
  }

  const free = await freeBytes()

  if (free !== null) {
    log(`${DIM}  ${formatBytes(free)} free on disk${RESET}`)

    if (free < 15 * 1024 ** 3) {
      warn('Under 15 GB free. `simwt sweep` and `simwt gc` both help.')
    }
  }
}
