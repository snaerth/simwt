import { resolveContext } from '../context.ts'
import { read } from '../registry.ts'
import { usableTemplates } from '../template.ts'
import { listRuntimes } from '../simctl.ts'
import { hasOrca } from '../orca.ts'
import { run } from '../exec.ts'
import { formatBytes, freeBytes } from '../disk.ts'
import { DIM, RESET, log } from '../log.ts'

export type DoctorOptions = { worktree?: string }

const PASS = 'ok  '
const WARN = 'warn'
const FAIL = 'fail'

function line(mark: string, message: string, detail?: string) {
  log(`${mark}  ${message}${detail === undefined ? '' : ` ${DIM}${detail}${RESET}`}`)
}

async function which(binary: string) {
  return (await run('which', [binary], { timeoutMs: 5000 })).exitCode === 0
}

export async function doctor(options: DoctorOptions) {
  for (const binary of ['xcrun', 'bun', 'pod', 'git']) {
    line(
      (await which(binary)) ? PASS : binary === 'pod' ? WARN : FAIL,
      `${binary} on PATH`,
      binary === 'pod' ? 'only needed when a native build runs' : undefined,
    )
  }

  line((await hasOrca()) ? PASS : WARN, 'orca CLI', 'optional, used for the emulator pane and --detached')

  const runtimes = await listRuntimes()
  const ready = runtimes.filter((runtime) => runtime.state === 'Ready')
  const unusable = runtimes.filter((runtime) => runtime.state !== 'Ready')

  line(ready.length > 0 ? PASS : FAIL, `${ready.length} Ready iOS runtime(s)`)

  for (const runtime of unusable) {
    line(WARN, `runtime ${runtime.version}/${runtime.build} is ${runtime.state}`, runtime.unusableReason ?? '')
  }

  const byVersion = new Map<string, number>()

  for (const runtime of ready) {
    byVersion.set(runtime.version, (byVersion.get(runtime.version) ?? 0) + 1)
  }

  for (const [version, count] of byVersion) {
    if (count > 1) {
      line(WARN, `${count} Ready runtimes share version ${version}`, 'pin "runtime" in simwt.json')
    }
  }

  const state = read()
  const templates = await usableTemplates(state)

  line(
    templates.length > 0 ? PASS : WARN,
    `${templates.length} usable template(s)`,
    templates.length === 0 ? 'run `simwt template bake`' : undefined,
  )

  const context = await resolveContext(options.worktree)

  if (context === null) {
    line(WARN, 'not an Expo project here', 'create and destroy will no-op')
  } else {
    line(
      PASS,
      `project ${context.worktree.project}`,
      `apps: ${Object.keys(context.config.apps).join(', ')}`,
    )
  }

  const free = await freeBytes()

  if (free !== null) {
    line(free > 15 * 1024 ** 3 ? PASS : WARN, `${formatBytes(free)} free on disk`)
  }

  const totalRuntimes = runtimes.reduce((sum, runtime) => sum + runtime.sizeBytes, 0)

  if (totalRuntimes > 20 * 1024 ** 3) {
    line(
      WARN,
      `${formatBytes(totalRuntimes)} of runtime images`,
      'xcrun simctl runtime delete --notUsedSinceDays 90 --dry-run',
    )
  }
}
