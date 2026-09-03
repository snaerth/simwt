import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type RunResult = { stdout: string; stderr: string; exitCode: number }

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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
