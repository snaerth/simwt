import fs from 'node:fs'
import path from 'node:path'
import { requireContext } from '../context.ts'
import { resolveApp } from '../expoConfig.ts'
import { BUILD_CACHE_DIR } from '../registry.ts'
import { run } from '../exec.ts'
import { buildsUnder, listDerivedBuilds } from '../derivedData.ts'
import { dirBytes, formatBytes } from '../disk.ts'
import { DIM, RESET, log, ok, step, warn } from '../log.ts'

export type CleanOptions = { app?: string; worktree?: string; apply: boolean; native: boolean }

type Target = { label: string; path: string; bytes: number }

/**
 * A generated native project is safe to delete and a checked in one is not, and the repo already
 * states which it is. Deleting a tracked `ios/` would throw away work that only exists there, so
 * git's answer is the gate rather than a flag.
 */
async function isGenerated(root: string) {
  const ignored = await run('git', ['check-ignore', '-q', 'ios'], { cwd: root, timeoutMs: 15_000 })

  return ignored.exitCode === 0
}

export async function clean(options: CleanOptions) {
  const { config, worktree } = await requireContext(options.worktree)
  const keys = options.app === undefined ? Object.keys(config.apps) : [options.app]

  for (const key of keys) {
    if (config.apps[key] === undefined) {
      return warn(`Unknown app "${key}". This project has: ${Object.keys(config.apps).join(', ')}`)
    }
  }

  const targets: Target[] = []
  const projectCache = path.join(BUILD_CACHE_DIR, worktree.project)

  if (fs.existsSync(projectCache)) {
    for (const entry of fs.readdirSync(projectCache)) {
      const match = entry.match(/^(.+)-[0-9a-f]{40}-Debug\.app$/)

      if (match === null || !keys.includes(match[1]!)) {
        continue
      }

      const full = path.join(projectCache, entry)

      targets.push({ label: `cached build ${entry}`, path: full, bytes: await dirBytes(full) })
    }
  }

  if (options.native) {
    const derived = await listDerivedBuilds()

    for (const key of keys) {
      const app = await resolveApp(config, key, worktree.path)
      const ios = path.join(app.root, 'ios')

      if (!fs.existsSync(ios)) {
        continue
      }

      if (!(await isGenerated(app.root))) {
        warn(`${key}: ios/ is tracked by git, leaving it alone`)
        continue
      }

      targets.push({ label: `${key} ios/ (generated)`, path: ios, bytes: await dirBytes(ios) })

      // Regenerating ios/ strands whatever Xcode built from it, and that folder is an order of
      // magnitude larger than everything else here put together.
      for (const build of buildsUnder(derived, app.root)) {
        targets.push({
          label: `${key} Xcode build folder ${build.name}`,
          path: build.path,
          bytes: build.bytes,
        })
      }
    }
  }

  if (targets.length === 0) {
    return ok('Nothing to clean')
  }

  const total = targets.reduce((sum, target) => sum + target.bytes, 0)

  for (const target of targets) {
    log(`  ${formatBytes(target.bytes).padEnd(9)} ${DIM}${target.label}${RESET}`)
  }

  if (!options.apply) {
    return log(`\nWould remove ${targets.length} item(s), reclaiming ${formatBytes(total)}.
Re-run with --apply to do it.`)
  }

  for (const target of targets) {
    step(`Removing ${target.label}`)
    fs.rmSync(target.path, { recursive: true, force: true })
  }

  ok(`Cleaned ${formatBytes(total)}. Next build starts from scratch.`)
}
