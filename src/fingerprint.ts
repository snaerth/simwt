import path from 'node:path'
import { createRequire } from 'node:module'
import { warn } from './log.ts'

type FingerprintModule = {
  createProjectHashAsync: (
    root: string,
    options: { platforms: string[] },
  ) => Promise<string>
}

let warned = false

/**
 * Resolved from the project, not from simwt. Repos pin different @expo/fingerprint versions and
 * the hash is not stable across them, so borrowing simwt's copy would quietly disagree with
 * both EAS and the repo's own build cache.
 */
export async function projectFingerprint(appRoot: string) {
  let mod: FingerprintModule

  try {
    mod = createRequire(path.join(appRoot, 'package.json'))(
      '@expo/fingerprint',
    ) as FingerprintModule
  } catch {
    if (!warned) {
      warn('Using simwt’s @expo/fingerprint. Add it to the project so hashes match EAS.')
      warned = true
    }

    mod = (await import('@expo/fingerprint')) as unknown as FingerprintModule
  }

  return mod.createProjectHashAsync(appRoot, { platforms: ['ios'] })
}
