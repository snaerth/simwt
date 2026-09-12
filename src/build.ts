import fs from 'node:fs'
import path from 'node:path'
import { run, runInherit } from './exec.ts'
import { fail, ok, step, warn } from './log.ts'
import { appContainer, installApp } from './simctl.ts'
import { BUILD_CACHE_DIR } from './registry.ts'
import type { App } from './expoConfig.ts'

export function cachedBuildPath(project: string, app: App, fingerprint: string) {
  return path.join(BUILD_CACHE_DIR, project, `${app.key}-${fingerprint}-Debug.app`)
}

/**
 * On SDK 57 the first pod install after a Podfile change can leave React.framework out of the
 * embed script, which crashes the app in dyld at launch. Running it twice is the known fix.
 *
 * `force` is what makes `--build` a repair rather than a repeat. That bad install leaves the two
 * lockfiles agreeing, so the matching pair below is not evidence the pods are sound, and skipping
 * on it would rebuild from exactly the same broken embed script.
 */
export async function ensurePods(app: App, force = false) {
  const iosDir = path.join(app.root, 'ios')
  const manifest = path.join(iosDir, 'Pods', 'Manifest.lock')
  const lock = path.join(iosDir, 'Podfile.lock')

  if (!fs.existsSync(path.join(iosDir, 'Podfile'))) {
    // No native project yet, so `expo run:ios` prebuilds and installs pods itself.
    return
  }

  if (
    !force &&
    fs.existsSync(manifest) &&
    fs.existsSync(lock) &&
    fs.readFileSync(manifest, 'utf8') === fs.readFileSync(lock, 'utf8')
  ) {
    return
  }

  for (const pass of [1, 2]) {
    step(`pod install for ${app.key} (pass ${pass} of 2)`)

    if ((await runInherit('pod', ['install'], { cwd: iosDir })) !== 0) {
      fail('pod install failed')
    }
  }
}

/**
 * A build whose embed script dropped a framework still installs cleanly and still caches cleanly.
 * It only fails at launch, in dyld, on whichever worktree installs it next, which is how one bad
 * pod install reaches every worktree that shares the fingerprint.
 *
 * So look at the bundle rather than the exit code: collect every `@rpath/<name>.framework/...`
 * the binaries load and check `Frameworks/` actually carries it.
 */
export async function missingFrameworks(appPath: string) {
  const frameworks = path.join(appPath, 'Frameworks')
  const present = new Set(
    fs.existsSync(frameworks)
      ? fs.readdirSync(frameworks).filter((entry) => entry.endsWith('.framework'))
      : [],
  )

  const binaries = [path.join(appPath, path.basename(appPath, '.app'))]

  for (const name of present) {
    binaries.push(path.join(frameworks, name, path.basename(name, '.framework')))
  }

  const missing = new Set<string>()

  for (const binary of binaries) {
    if (!fs.existsSync(binary)) {
      continue
    }

    const listed = await run('otool', ['-L', binary], { timeoutMs: 30_000 })

    for (const line of listed.stdout.split('\n')) {
      const match = line.trim().match(/^@rpath\/([^/]+\.framework)\//)

      if (match !== null && !present.has(match[1]!)) {
        missing.add(match[1]!)
      }
    }
  }

  return [...missing]
}

async function cacheBuild(udid: string, project: string, app: App, fingerprint: string) {
  const source = await appContainer(udid, app.bundleId)

  if (source === null) {
    return
  }

  const destination = cachedBuildPath(project, app, fingerprint)

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.rmSync(destination, { recursive: true, force: true })
  // clonefile keeps this near instant and nearly free on APFS.
  await run('cp', ['-c', '-R', source, destination])
  ok(`Cached ${app.key} build ${fingerprint.slice(0, 12)}`)
}

export type EnsureResult = 'current' | 'installed' | 'built'

/**
 * Brings the app on this simulator up to the worktree's fingerprint. A drifted template is a
 * warmth problem rather than a correctness one, so a mismatch reinstalls from the cache instead
 * of refusing and sending someone off to rebake.
 */
export async function ensureApp(options: {
  udid: string
  project: string
  app: App
  fingerprint: string
  installedFingerprint: string | null
  forceBuild: boolean
  allowBuild: boolean
}): Promise<EnsureResult | null> {
  const { udid, project, app, fingerprint, installedFingerprint, forceBuild, allowBuild } = options
  const installed = await appContainer(udid, app.bundleId)

  if (!forceBuild && installed !== null && installedFingerprint === fingerprint) {
    return 'current'
  }

  const cached = cachedBuildPath(project, app, fingerprint)

  if (!forceBuild && fs.existsSync(cached)) {
    // Entries cached before this was checked, or by a hand rolled copy, are still out there.
    const broken = await missingFrameworks(cached)

    if (broken.length > 0) {
      warn(`Cached ${app.key} build is missing ${broken.join(', ')}, discarding it`)
      fs.rmSync(cached, { recursive: true, force: true })
    }
  }

  if (!forceBuild && fs.existsSync(cached)) {
    step(`Installing cached ${app.key} build ${fingerprint.slice(0, 12)}`)

    const result = await installApp(udid, cached)

    if (result.exitCode !== 0) {
      fail(`Installing the cached build failed. ${result.stderr.trim()}`)
    }

    // Keep mtime honest so cache eviction is a real LRU rather than creation order.
    fs.utimesSync(cached, new Date(), new Date())

    return 'installed'
  }

  if (!allowBuild) {
    return null
  }

  step(`Building ${app.key}, nothing cached for ${fingerprint.slice(0, 12)}`)

  await ensurePods(app, forceBuild)

  // No --port alongside --no-bundler, the two are mutually exclusive on SDK 57. `expo run:ios`
  // ends by opening the app on an address of its own choosing, which is exactly the stale socket
  // the dev client step then has to undo.
  const built = await runInherit('bunx', ['expo', 'run:ios', '--device', udid, '--no-bundler'], {
    cwd: app.root,
  })

  // `expo run:ios` ends by opening the app, and that last step fails on its own terms: openurl
  // against an app mid cold launch times out with POSIX 60. The build and the install are already
  // done by then, so what is installed decides whether this worked, not the exit code. We throw
  // the launch away regardless, since pointDevClient has to cold start the app itself.
  if (built !== 0 && (await appContainer(udid, app.bundleId)) === null) {
    fail('Native build failed')
  }

  if (built !== 0) {
    warn('The build succeeded but `expo run:ios` could not open the app. Carrying on.')
  }

  const bundle = await appContainer(udid, app.bundleId)
  const broken = bundle === null ? [] : await missingFrameworks(bundle)

  if (broken.length > 0) {
    fail(
      `The build is missing ${broken.join(', ')}, so it would crash in dyld at launch. ` +
        'This is the pod install that drops a framework from the embed script. ' +
        'Re-run with --build, which reinstalls the pods twice before building.',
    )
  }

  await cacheBuild(udid, project, app, fingerprint)

  return 'built'
}

/** Fingerprints pinned by a live sim or a template are never evicted. */
export function evictCache(pinned: Set<string>, keepPerApp = 3) {
  if (!fs.existsSync(BUILD_CACHE_DIR)) {
    return 0
  }

  type Entry = { path: string; app: string; fingerprint: string; mtime: number }
  const entries: Entry[] = []

  for (const project of fs.readdirSync(BUILD_CACHE_DIR)) {
    const dir = path.join(BUILD_CACHE_DIR, project)

    if (!fs.statSync(dir).isDirectory()) {
      continue
    }

    for (const name of fs.readdirSync(dir)) {
      const match = name.match(/^(.+)-([0-9a-f]{40})-Debug\.app$/)

      if (match === null) {
        continue
      }

      const full = path.join(dir, name)

      entries.push({
        path: full,
        app: `${project}/${match[1]}`,
        fingerprint: match[2]!,
        mtime: fs.statSync(full).mtimeMs,
      })
    }
  }

  const perApp = new Map<string, Entry[]>()

  for (const entry of entries) {
    perApp.set(entry.app, [...(perApp.get(entry.app) ?? []), entry])
  }

  const doomed: Entry[] = []

  for (const group of perApp.values()) {
    const sorted = group.sort((a, b) => b.mtime - a.mtime)

    doomed.push(...sorted.slice(keepPerApp).filter((entry) => !pinned.has(entry.fingerprint)))
  }

  let removed = 0

  for (const entry of doomed) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      warn(`Could not evict ${entry.path}. ${String(error)}`)
    }
  }

  return removed
}
