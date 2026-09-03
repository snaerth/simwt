import fs from 'node:fs'
import path from 'node:path'
import { run } from './exec.ts'
import { fail } from './log.ts'
import type { SimwtConfig } from './config.ts'

export type App = {
  key: string
  root: string
  bundleId: string
  scheme: string
  /** Every scheme the app answers on, so the template can approve all of them at once. */
  schemes: string[]
  displayName: string
}

/**
 * Read back out of the resolved Expo config, never off app.json. Build variants rewrite the
 * bundle id and the scheme, and the Expo CLI's own resolver picks the longest iOS scheme, which
 * on these apps is an OAuth redirect the dev client does not answer on.
 */
export async function resolveApp(
  config: SimwtConfig,
  appKey: string,
  worktreeRoot: string,
): Promise<App> {
  const entry = config.apps[appKey]

  if (entry === undefined) {
    return fail(`Unknown app "${appKey}"`)
  }

  const root = path.resolve(worktreeRoot, entry.dir)

  if (!fs.existsSync(root)) {
    return fail(`No app directory at ${root}`)
  }

  const result = await run('bunx', ['expo', 'config', '--type', 'public', '--json'], {
    cwd: root,
    timeoutMs: 120_000,
  })

  if (result.exitCode !== 0) {
    return fail(`Could not resolve the Expo config for ${appKey}. ${result.stderr.trim()}`)
  }

  const parsed = JSON.parse(result.stdout) as {
    name?: string
    slug?: string
    scheme?: string | string[]
    ios?: { bundleIdentifier?: string }
  }
  const bundleId = parsed.ios?.bundleIdentifier
  const declared = Array.isArray(parsed.scheme)
    ? parsed.scheme
    : parsed.scheme === undefined
      ? []
      : [parsed.scheme]
  const scheme = declared[0]

  if (bundleId === undefined || scheme === undefined) {
    return fail(`The Expo config for ${appKey} has no ios.bundleIdentifier or scheme`)
  }

  // The dev client also answers on `exp+<slug>`, and that is the one a fresh install tends to
  // prompt about first.
  const schemes = [...new Set([...declared, ...(parsed.slug === undefined ? [] : [`exp+${parsed.slug}`])])]

  return {
    key: appKey,
    root,
    bundleId,
    scheme,
    schemes,
    displayName: parsed.name ?? appKey,
  }
}
