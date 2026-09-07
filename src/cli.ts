import { setQuiet, fail, log } from './log.ts'
import { QUIET_ON_THE_NETWORK } from './exec.ts'
import { create } from './commands/create.ts'
import { warm } from './commands/warm.ts'
import { destroy } from './commands/destroy.ts'
import { up } from './commands/up.ts'
import { down } from './commands/down.ts'
import { status } from './commands/status.ts'
import { sweep } from './commands/sweep.ts'
import { doctor } from './commands/doctor.ts'
import { gc } from './commands/gc.ts'
import { template } from './commands/template.ts'

const COMMANDS = [
  'up',
  'create',
  'warm',
  'destroy',
  'down',
  'status',
  'sweep',
  'gc',
  'doctor',
  'template',
] as const

const HELP = `simwt - one iOS simulator per git worktree

  simwt up [app]            bring this worktree up on its simulator and run Metro
  simwt create              clone a simulator for this worktree (worktree setup hook)
  simwt warm                boot it, install, and open the app on Metro (worktree setup hook)
  simwt destroy             delete this worktree's simulator (worktree archive hook)
  simwt down [app]          stop this worktree's detached Metro
  simwt status              every simwt simulator on this machine
  simwt sweep               reclaim simulators whose worktree is gone (dry run by default)
  simwt gc                  shrink simulators in place by pruning their caches
  simwt doctor              check the machine and this project
  simwt template bake       bake a golden template to clone from
  simwt template list|rm

Flags
  --app <key>               which app, when a project has more than one
  --worktree <path>         act on this worktree rather than the current directory
  --device "iPhone 17"      device model, for create and template bake
  --runtime 26.0.1/23A8464  runtime pin, for template bake
  --apps lotto,lengjan      which apps the template carries, for template bake
  --build                   force a native rebuild
  --detached                give Metro its own Orca tab and return
  --no-metro                point the dev client but do not start Metro
  --apply                   actually do it, for sweep and gc
  --all                     include your own simulators, for gc
  --include-idle            also remove simulators for live but unused worktrees, for sweep
  --budget <seconds>        time warm is allowed to take
  --no-launch               warm without starting Metro or opening the app
  --force                   recreate even if a simulator already exists
  --json --quiet            machine readable, and hook friendly
`

function flag(argv: string[], name: string) {
  return argv.includes(`--${name}`)
}

function value(argv: string[], name: string) {
  const index = argv.indexOf(`--${name}`)

  return index === -1 ? undefined : argv[index + 1]
}

/**
 * Setting these here rather than on each child is enough, because `childEnv` spreads
 * `process.env`. The one path that misses out is the Orca tab, which `metro.ts` prefixes itself
 * because the tab is created by Orca rather than spawned from here.
 */
function quietOnTheNetwork() {
  Object.assign(process.env, QUIET_ON_THE_NETWORK)
}

export async function main(argv: string[]) {
  quietOnTheNetwork()

  if (flag(argv, 'help') || argv[0] === 'help') {
    log(HELP)

    return
  }

  setQuiet(flag(argv, 'quiet'))

  const valued = new Set(['app', 'worktree', 'device', 'runtime', 'budget', 'name', 'apps'])
  const positional = argv.filter((entry, index) => {
    if (entry.startsWith('--')) {
      return false
    }

    const previous = argv[index - 1]

    return previous === undefined || !previous.startsWith('--') || !valued.has(previous.slice(2))
  })

  const command = positional.find((entry) => (COMMANDS as readonly string[]).includes(entry)) ?? 'up'
  const rest = positional.filter((entry) => entry !== command)
  const worktree = value(argv, 'worktree')

  switch (command) {
    case 'up':
      return up({
        app: value(argv, 'app') ?? rest[0],
        worktree,
        build: flag(argv, 'build'),
        detached: flag(argv, 'detached'),
        noMetro: flag(argv, 'no-metro'),
      })
    case 'create':
      return create({ worktree, device: value(argv, 'device'), force: flag(argv, 'force') })
    case 'warm':
      return warm({
        worktree,
        budgetSeconds: Number(value(argv, 'budget') ?? 80),
        launch: !flag(argv, 'no-launch'),
      })
    case 'destroy':
      return destroy({ worktree })
    case 'down':
      return down({ app: value(argv, 'app') ?? rest[0], worktree })
    case 'status':
      return status({ worktree, json: flag(argv, 'json') })
    case 'sweep':
      return sweep({
        apply: flag(argv, 'apply'),
        olderThanDays: Number(value(argv, 'older-than') ?? 7),
        includeIdle: flag(argv, 'include-idle'),
      })
    case 'gc':
      return gc({ apply: flag(argv, 'apply'), all: flag(argv, 'all') })
    case 'doctor':
      return doctor({ worktree })
    case 'template': {
      const action = rest[0] ?? 'list'

      if (action !== 'bake' && action !== 'list' && action !== 'rm') {
        return fail(`Unknown template action "${action}". Use bake, list or rm.`)
      }

      return template({
        action,
        worktree,
        device: value(argv, 'device'),
        runtime: value(argv, 'runtime'),
        apps: value(argv, 'apps'),
        name: rest[1],
      })
    }
    default:
      return fail(`Unknown command "${command}"`)
  }
}
