import fs from 'node:fs'
import path from 'node:path'
import { fail } from './log.ts'

export type AppConfig = { dir: string }

export type SimwtConfig = {
  project: string
  defaultApp: string
  device: string
  /** Optional pin, `version` or `version/build`. Only `template bake` reads it. */
  runtime: string | null
  warmOnCreate: string[]
  apps: Record<string, AppConfig>
}

type ConfigFile = Partial<Omit<SimwtConfig, 'apps'>> & { apps?: Record<string, AppConfig> }

const APP_MANIFESTS = ['app.json', 'app.config.ts', 'app.config.js', 'app.config.mjs']

function looksLikeExpoApp(dir: string) {
  return APP_MANIFESTS.some((name) => fs.existsSync(path.join(dir, name)))
}

/**
 * Not every repo with the hooks installed is an app repo. Returning null lets `create` and
 * `destroy` exit quietly so the same hook text is safe to paste into an API or an infra repo.
 */
export function loadConfig(worktreeRoot: string, project: string): SimwtConfig | null {
  const configPath = path.join(worktreeRoot, 'simwt.json')

  if (fs.existsSync(configPath)) {
    let parsed: ConfigFile

    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigFile
    } catch (error) {
      return fail(`simwt.json is not valid JSON. ${String(error)}`)
    }

    const apps = parsed.apps ?? {}
    const keys = Object.keys(apps)

    if (keys.length === 0) {
      return fail('simwt.json declares no apps')
    }

    const defaultApp = parsed.defaultApp ?? keys[0]!

    if (apps[defaultApp] === undefined) {
      return fail(`simwt.json sets defaultApp to "${defaultApp}", which is not in apps`)
    }

    return {
      project: parsed.project ?? project,
      defaultApp,
      device: parsed.device ?? 'iPhone 17',
      runtime: parsed.runtime ?? null,
      warmOnCreate: parsed.warmOnCreate ?? [defaultApp],
      apps,
    }
  }

  // Zero config: a single Expo app sitting at the repo root, which is the common shape.
  if (!looksLikeExpoApp(worktreeRoot)) {
    return null
  }

  return {
    project,
    defaultApp: project,
    device: 'iPhone 17',
    runtime: null,
    warmOnCreate: [project],
    apps: { [project]: { dir: '.' } },
  }
}

export function resolveAppKey(config: SimwtConfig, requested?: string) {
  if (requested === undefined) {
    return config.defaultApp
  }

  if (config.apps[requested] === undefined) {
    return fail(`Unknown app "${requested}". This project has: ${Object.keys(config.apps).join(', ')}`)
  }

  return requested
}
