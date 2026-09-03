import { loadConfig, type SimwtConfig } from './config.ts'
import { resolveWorktree, type Worktree } from './worktree.ts'
import { fail } from './log.ts'

export type Context = { worktree: Worktree; config: SimwtConfig }

/**
 * Null when this is not an app repo, which is the case the hooks rely on. The same hook text is
 * pasted into every project, so an API or infra repo has to be a quiet no-op rather than an error.
 */
export async function resolveContext(explicitWorktree?: string): Promise<Context | null> {
  const worktree = await resolveWorktree(explicitWorktree)
  const config = loadConfig(worktree.path, worktree.project)

  return config === null ? null : { worktree, config }
}

export async function requireContext(explicitWorktree?: string): Promise<Context> {
  const context = await resolveContext(explicitWorktree)

  if (context === null) {
    return fail(
      'This does not look like an Expo project. Add a simwt.json, or run from a repo with an app.json.',
    )
  }

  return context
}
