import net from 'node:net'
import type { State } from './registry.ts'
import { fail } from './log.ts'

/**
 * One pool for the whole machine rather than a range per project. Because the state file is
 * global, two projects cannot be handed the same port, which a per project base can only
 * approximate.
 *
 * The range sits clear of 8081 and 8082, which plain `expo start` and the Android device use,
 * and clear of 8181 to 8219, which lotto-apps' own scripts/sim.ts still hands out. Once that
 * script is gone this can move down.
 */
const RANGE_START = 8301
const RANGE_END = 8400

export function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer()

    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** Whether a Metro, rather than something else, is answering on this port. */
export async function isMetroUp(port: number) {
  try {
    const response = await fetch(`http://localhost:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    })

    return (await response.text()).includes('packager-status:running')
  } catch {
    return false
  }
}

function taken(state: State) {
  const ports = new Set<number>()

  for (const sim of Object.values(state.sims)) {
    for (const app of Object.values(sim.apps)) {
      ports.add(app.port)
    }
  }

  return ports
}

/**
 * Sticky while it stays ours. Nothing compiles the port into the binary on this stack, so a
 * port can move without invalidating a cached build, but a stable one keeps devtools bookmarks
 * and muscle memory working.
 */
export function allocate(state: State, udid: string, appKey: string): number {
  const existing = state.sims[udid]?.apps[appKey]?.port

  if (existing !== undefined) {
    return existing
  }

  const used = taken(state)

  for (let port = RANGE_START; port <= RANGE_END; port++) {
    if (!used.has(port)) {
      return port
    }
  }

  return fail(`No free Metro port between ${RANGE_START} and ${RANGE_END}. Run \`simwt sweep\`.`)
}
