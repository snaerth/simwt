import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type RunResult = { stdout: string; stderr: string; exitCode: number }

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * A simulator bound to one worktree has no reason to announce itself. `expo start` advertises
 * `_expo._tcp` on the LAN by default, carrying the app name, slug, both bundle ids and the Expo
 * username, so everyone else's dev client lists a row per worktree you have open. The dev-session
 * ping is a second, independent channel that posts the hostname and dev-server URL to Expo.
 *
 * Neither switch covers the other, and `--offline` notably leaves the mDNS beacon running.
 */
export const QUIET_ON_THE_NETWORK = {
  EXPO_UNSTABLE_BONJOUR: '0',
  EXPO_OFFLINE: '1',
}

/** For a command that is handed to a shell rather than spawned as a child of this process. */
export function envPrefix(env: Record<string, string>) {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')
}

/**
 * CocoaPods aborts on these projects unless the locale is UTF-8, and the Expo CLI inherits the
 * same environment, so every child gets it rather than only `pod`.
 */
function childEnv() {
  return { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
}

/**
 * Never build a shell string here. Simulator names contain spaces, so every argument goes
 * through the args array where the shell cannot word split it.
 */
export async function run(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: childEnv(),
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
    })

    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string }

    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

/** For children that own the terminal, so Metro keeps its keybindings and a build shows progress. */
export function runInherit(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, env: childEnv(), stdio: 'inherit' })

    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}
