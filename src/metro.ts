import { QUIET_ON_THE_NETWORK, envPrefix, runInherit, sleep } from './exec.ts'
import { fail, ok, step, warn } from './log.ts'
import { isMetroUp, isPortFree } from './ports.ts'
import { terminalClose, terminalCreate } from './orca.ts'
import type { App } from './expoConfig.ts'

export function metroTitle(app: App, port: number) {
  return `metro:${app.key}:${port}`
}

function metroArgs(app: App, port: number) {
  return ['--cwd', app.root, 'start', '--port', String(port)]
}

/**
 * The default path. Metro takes over this terminal, so there is one tab rather than two and its
 * keybindings, `r` to reload and `j` for the debugger, reach the terminal already in front of
 * you. It inherits stdio, which hands it the TTY and therefore the keyboard, and we stay alive
 * beside it only long enough to finish pointing the dev client.
 */
export async function runMetroHere(app: App, port: number, afterReady: () => Promise<void>) {
  if (!(await isPortFree(port))) {
    fail(`Port ${port} is taken by something that is not Metro. Free it and re-run.`)
  }

  step(`Starting Metro on ${port} in this terminal`)

  let exited = false
  const metro = runInherit('bun', metroArgs(app, port)).then((code) => {
    exited = true

    return code
  })

  const finish = (async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (exited) {
        return
      }

      if (await isMetroUp(port)) {
        await afterReady()

        return
      }

      await sleep(1000)
    }

    warn(`Metro did not answer on ${port}, so the dev client was left alone`)
  })()

  await Promise.all([metro, finish])
}

/**
 * The --detached path. Metro gets its own Orca tab and the command returns.
 *
 * The returned handle is recorded, because a tab outlives the Metro inside it after a Ctrl+C
 * and terminal titles are set by whatever is running in them. Without the handle every restart
 * would strand another tab.
 */
export async function startMetroInTab(app: App, port: number, recorded: string | null) {
  if (recorded !== null) {
    warn(`Replacing the Metro tab for ${port}, nothing is answering in it`)
    await terminalClose(recorded)
  }

  if (!(await isPortFree(port))) {
    fail(`Port ${port} is taken by something that is not Metro. Free it and re-run.`)
  }

  step(`Starting Metro on ${port}`)

  const handle = await terminalCreate(
    metroTitle(app, port),
    // Orca creates this tab, so unlike every other child it does not inherit what `cli.ts` set.
    `${envPrefix(QUIET_ON_THE_NETWORK)} bun --cwd ${JSON.stringify(app.root)} start --port ${port}`,
  )

  if (handle === null) {
    fail('--detached needs the orca CLI. Run without it and Metro will own this terminal.')
  }

  for (let attempt = 0; attempt < 120; attempt++) {
    if (await isMetroUp(port)) {
      ok(`Metro ready on ${port}`)

      return handle
    }

    await sleep(1000)
  }

  return fail(`Metro did not come up on ${port}. Check the ${metroTitle(app, port)} terminal.`)
}
