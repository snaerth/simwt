import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './exec.ts'
import { dirBytes } from './disk.ts'

export const DERIVED_DATA_DIR = path.join(
  os.homedir(),
  'Library',
  'Developer',
  'Xcode',
  'DerivedData',
)

export type DerivedBuild = {
  name: string
  path: string
  /** The `.xcworkspace` or `.xcodeproj` Xcode built from, as an absolute path. */
  workspace: string
  bytes: number
}

/**
 * Xcode keys a build folder to the absolute path of the workspace, so one simulator per worktree
 * also means one multi gigabyte build folder per worktree, and archiving the worktree leaves the
 * folder behind forever. This is by far the largest thing simwt's model creates and the only one
 * nothing was reclaiming.
 *
 * Folders without an `info.plist` are the shared caches, `ModuleCache.noindex` and friends. They
 * belong to no workspace, every project uses them, and they are never listed here.
 */
export async function listDerivedBuilds(): Promise<DerivedBuild[]> {
  if (!fs.existsSync(DERIVED_DATA_DIR)) {
    return []
  }

  const builds: DerivedBuild[] = []

  for (const name of fs.readdirSync(DERIVED_DATA_DIR)) {
    const full = path.join(DERIVED_DATA_DIR, name)
    const info = path.join(full, 'info.plist')

    if (!fs.existsSync(info)) {
      continue
    }

    // plutil rather than reading the XML, because Xcode is free to write this one as a binary plist.
    const extracted = await run(
      'plutil',
      ['-extract', 'WorkspacePath', 'raw', '-o', '-', info],
      { timeoutMs: 15_000 },
    )

    const workspace = extracted.stdout.trim()

    if (extracted.exitCode !== 0 || workspace.length === 0) {
      continue
    }

    builds.push({ name, path: full, workspace, bytes: await dirBytes(full) })
  }

  return builds
}

/** Everything Xcode built for a checkout, found by the workspace living inside it. */
export function buildsUnder(builds: DerivedBuild[], root: string) {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`

  return builds.filter((build) => build.workspace.startsWith(prefix))
}

/**
 * A missing workspace is positive evidence rather than absence of it: Xcode wrote that path, so
 * the checkout was there when it did. A path outside the home directory is not judged at all,
 * since an external volume that is merely unmounted looks exactly like a deleted one.
 */
export function isOrphan(build: DerivedBuild) {
  return (
    build.workspace.startsWith(`${os.homedir()}${path.sep}`) && !fs.existsSync(build.workspace)
  )
}

export function removeBuild(build: DerivedBuild) {
  fs.rmSync(build.path, { recursive: true, force: true })
}
