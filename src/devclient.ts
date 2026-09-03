import fs from 'node:fs'
import path from 'node:path'
import { run, sleep } from './exec.ts'
import { ok, note, warn } from './log.ts'
import { appContainer, openUrl, terminateApp, type Device } from './simctl.ts'
import type { App } from './expoConfig.ts'

type InspectorTarget = { appId?: string; deviceName?: string }

/**
 * Whether the app on this simulator loaded its bundle from the Metro on this port.
 *
 * React Native registers a debugger target with the dev server it loaded from, so this is
 * evidence rather than a guess. It is not proof that the packager socket is here too, those are
 * separate connections and they can disagree, but an app missing from this list is certainly
 * not ours.
 */
export async function isAttachedToMetro(app: App, device: Device, port: number) {
  try {
    const response = await fetch(`http://localhost:${port}/json/list`, {
      signal: AbortSignal.timeout(2000),
    })
    const targets = (await response.json()) as InspectorTarget[]

    return targets.some(
      (target) =>
        target.appId === app.bundleId &&
        (target.deviceName === device.name || (target.deviceName ?? '').includes(device.name)),
    )
  } catch {
    return false
  }
}

function plistBuddy(file: string, commands: string[]) {
  return run(
    '/usr/libexec/PlistBuddy',
    commands.flatMap((command) => ['-c', command]).concat(file),
  )
}

/**
 * Stops the dev launcher reopening whatever bundle it opened last.
 *
 * That bundle belongs to whoever used this simulator before, and it becomes the app context
 * `expo-dev-menu` binds the packager socket to. The preference has to go in the app's own
 * container. The device level domain of the same name looks right and is ignored, and because
 * `simctl install` wipes the container this has to be re-asserted after every install.
 */
export async function disableAutoLaunch(udid: string, app: App) {
  const container = await appContainer(udid, app.bundleId, 'data')

  if (container === null) {
    return
  }

  const prefs = path.join(container, 'Library', 'Preferences')
  const file = path.join(prefs, `${app.bundleId}.plist`)

  fs.mkdirSync(prefs, { recursive: true })

  if (!fs.existsSync(file)) {
    await run('/usr/bin/plutil', ['-create', 'binary1', file])
  }

  // Add fails when the key is already there and Set fails when it is not, so both run and the
  // pair is what actually guarantees the value.
  await plistBuddy(file, [
    'Add :EXDevLauncherTryToLaunchLastBundle bool false',
    'Set :EXDevLauncherTryToLaunchLastBundle false',
    'Add :EXDevMenuIsOnboardingFinished bool true',
    'Set :EXDevMenuIsOnboardingFinished true',
  ])
}

const SCHEME_APPROVAL_CALLER = 'com.apple.CoreSimulator.CoreSimulatorBridge'

function schemeApprovalPath(dataPath: string) {
  return path.join(dataPath, 'Library', 'Preferences', 'com.apple.launchservices.schemeapproval.plist')
}

/**
 * Pre-answers the "Open in ...?" confirmation iOS puts up the first time a scheme is opened on a
 * simulator, which otherwise swallows the deep link until a human taps it.
 *
 * The record is device level, so it survives both a clone and an app reinstall. Write it while
 * the device is shut down, since a booted cfprefsd holds the domain in memory and flushes its
 * own copy back over this one.
 */
export async function approveSchemes(dataPath: string, bundleId: string, schemes: string[]) {
  const file = schemeApprovalPath(dataPath)

  fs.mkdirSync(path.dirname(file), { recursive: true })

  if (!fs.existsSync(file)) {
    await run('/usr/bin/plutil', ['-create', 'binary1', file])
  }

  for (const scheme of schemes) {
    const key = `:"${SCHEME_APPROVAL_CALLER}-->${scheme}"`

    await plistBuddy(file, [`Add ${key} string ${bundleId}`, `Set ${key} ${bundleId}`])
  }
}

export async function readApprovedSchemes(dataPath: string) {
  const file = schemeApprovalPath(dataPath)

  if (!fs.existsSync(file)) {
    return {}
  }

  const result = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])

  if (result.exitCode !== 0) {
    return {}
  }

  try {
    return JSON.parse(result.stdout) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Points the dev client at this Metro, by cold starting it on the deep link.
 *
 * The port cannot be built in. RCT_METRO_PORT is a compile time macro baked to 8081 in the
 * prebuilt React Native core, so what decides the address at runtime is expo-dev-menu
 * reconnecting the packager socket to the URL the app context launched with. Opening the link
 * against a running app moves the bundle but leaves that socket where it was, and then reload
 * and the dev menu are dropped while everything else still looks right. Hence terminate first,
 * open second. It also avoids the POSIX 60 timeout that `openurl` hits against an app that is
 * mid cold launch.
 */
export async function pointDevClient(app: App, device: Device, port: number) {
  if (await isAttachedToMetro(app, device, port)) {
    ok(`Dev client already attached to http://localhost:${port}`)

    return true
  }

  await disableAutoLaunch(device.udid, app)
  await terminateApp(device.udid, app.bundleId)

  const target = encodeURIComponent(`http://localhost:${port}`)
  const result = await openUrl(device.udid, `${app.scheme}://expo-development-client/?url=${target}`)

  if (result.exitCode !== 0) {
    warn(`Deep link failed. Pick "http://localhost:${port}" in the dev launcher.`)

    return false
  }

  for (let attempt = 0; attempt < 90; attempt++) {
    if (await isAttachedToMetro(app, device, port)) {
      ok(`Dev client attached to http://localhost:${port}`)

      return true
    }

    await sleep(1000)
  }

  warn(`${app.key} never attached to http://localhost:${port}, so reload and the dev menu will not work.`)
  note('If the simulator is showing an "Open in ..." prompt, answer it and re-run. The template')
  note('should have pre-approved it, so seeing one means `simwt template bake` is due.')

  return false
}
