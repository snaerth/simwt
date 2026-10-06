/**
 * Every device simwt owns starts with one of these. Sweep refuses to touch anything else, so
 * the prefix is the only thing standing between it and a daily driver holding gigabytes of
 * signed in app state.
 */
export const SIM_PREFIX = 'simwt-'
export const TEMPLATE_PREFIX = 'simwt-tpl-'

export function slugify(value: string, max = 32) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')

  return slug.length === 0 ? 'x' : slug
}

/**
 * The instance id suffix is what keeps two worktrees called `main` in different projects apart,
 * and gives a recreated worktree a fresh device instead of colliding with its predecessor's.
 */
export function simName(project: string, worktree: string, instanceId: string) {
  const projectSlug = slugify(project)
  const worktreeSlug = slugify(worktree)
  // The primary checkout's directory is the project, so naming it twice reads badly.
  const label = projectSlug === worktreeSlug ? projectSlug : `${projectSlug}-${worktreeSlug}`

  return `${SIM_PREFIX}${label}-${instanceId.replace(/-/g, '').slice(0, 8)}`
}

export function isSimwtSim(name: string) {
  return name.startsWith(SIM_PREFIX) && !name.startsWith(TEMPLATE_PREFIX)
}

export function isSimwtTemplate(name: string) {
  return name.startsWith(TEMPLATE_PREFIX)
}

/**
 * The project is part of the name because a template is only ever cloned for the project it was
 * baked for. Without it every repo competes for one name per device and runtime, so baking in one
 * deletes the other's template and its worktrees silently fall back to a bare simulator.
 *
 * The build suffix is not decoration either. Two Ready runtimes can share one identifier, so a
 * template named only for its version would silently mean either of them.
 */
export function templateName(project: string, deviceType: string, version: string, build: string) {
  return `${TEMPLATE_PREFIX}${slugify(project)}-${slugify(deviceType)}-${slugify(version)}-${slugify(build)}`
}

/**
 * What `templateName` produced before the project was part of it. Only used to reclaim leftovers
 * from before the rename, and only when the registry has no record of them.
 */
export function legacyTemplateName(deviceType: string, version: string, build: string) {
  return `${TEMPLATE_PREFIX}${slugify(deviceType)}-${slugify(version)}-${slugify(build)}`
}

/** Turns a model name like "iPhone 17" into the CoreSimulator device type identifier. */
export function deviceTypeIdentifier(model: string) {
  return `com.apple.CoreSimulator.SimDeviceType.${model.trim().replace(/\s+/g, '-')}`
}

/** Strips the CoreSimulator prefix off a device type so it reads as a model name. */
export function shortDeviceType(identifier: string) {
  return identifier.replace('com.apple.CoreSimulator.SimDeviceType.', '')
}
