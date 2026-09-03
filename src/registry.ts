import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sleep } from './exec.ts'
import { fail, warn } from './log.ts'

export const STATE_DIR = path.join(os.homedir(), '.simwt')
export const STATE_PATH = path.join(STATE_DIR, 'state.json')
export const LOCK_PATH = path.join(STATE_DIR, 'state.lock')
export const BUILD_CACHE_DIR = path.join(STATE_DIR, 'build-cache')

export type AppRecord = {
  /** Null until Metro actually runs for this app. A port is meaningless before that. */
  port: number | null
  fingerprint: string | null
  metroTerminal: string | null
  updatedAt: string
}

export type SimRecord = {
  name: string
  project: string
  worktreePath: string
  worktreeName: string
  instanceId: string
  templateUdid: string | null
  createdAt: string
  heartbeatAt: string
  apps: Record<string, AppRecord>
}

export type TemplateRecord = {
  name: string
  project: string
  deviceTypeIdentifier: string
  runtimeIdentifier: string
  runtimeVersion: string
  runtimeBuild: string
  runtimeBundlePath: string
  bakedAt: string
  bakedBytes: number
  /** app key to the fingerprint that was installed when this template was baked */
  apps: Record<string, { bundleId: string; scheme: string; fingerprint: string }>
  schemeApprovalVerified: boolean
  driftCount: number
}

export type State = {
  version: 1
  machine: {
    cloneIsCopyOnWrite: boolean | null
    freeSpaceFloorBytes: number
  }
  /** keyed by simulator udid */
  sims: Record<string, SimRecord>
  /** keyed by template simulator udid */
  templates: Record<string, TemplateRecord>
}

const EMPTY: State = {
  version: 1,
  machine: { cloneIsCopyOnWrite: null, freeSpaceFloorBytes: 8 * 1024 * 1024 * 1024 },
  sims: {},
  templates: {},
}

/** Never throws. A machine with a mangled state file should still be able to run `up`. */
export function read(): State {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as Partial<State>

    return {
      version: 1,
      machine: { ...EMPTY.machine, ...parsed.machine },
      sims: parsed.sims ?? {},
      templates: parsed.templates ?? {},
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`The simwt state file could not be read, starting from empty. ${String(error)}`)
    }

    return structuredClone(EMPTY)
  }
}

function write(state: State) {
  fs.mkdirSync(STATE_DIR, { recursive: true })

  const temp = `${STATE_PATH}.${process.pid}.tmp`

  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temp, STATE_PATH)
}

/**
 * mkdir is atomic on APFS, which is all the mutual exclusion this needs. Orca can run several
 * worktree setup hooks at once and every one of them rewrites this file.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(STATE_DIR, { recursive: true })

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fs.mkdirSync(LOCK_PATH)

      try {
        return await fn()
      } finally {
        fs.rmSync(LOCK_PATH, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      // A hook killed mid write would otherwise wedge every later run.
      if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 60_000) {
        fs.rmSync(LOCK_PATH, { recursive: true, force: true })
      }

      await sleep(100)
    }
  }

  return fail('Could not acquire the simwt state lock')
}

/**
 * The only way to mutate state, so the lock cannot be forgotten. Keep the callback short. It
 * must never contain a build, a pod install, a clone or a Metro run, all of which outlive the
 * lock's staleness window and would let a second process break in underneath.
 */
export function update<T>(mutate: (state: State) => T): Promise<T> {
  return withLock(async () => {
    const state = read()
    const result = mutate(state)

    write(state)

    return result
  })
}
