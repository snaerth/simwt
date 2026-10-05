# Invariants

The things that are easy to get wrong here, and why the code is shaped the way it is. Measured
on macOS 26, Xcode 26, Expo SDK 57.

## The dev client must be cold started on the deep link

`RCT_METRO_PORT` is a compile time macro, defaulted to 8081 in `RCTDefines.h` and baked into the
binary. On SDK 57 React Native core ships as a prebuilt xcframework, so the macro is fixed before
we ever build and passing it to `pod install` or `xcodebuild` does nothing.

What actually decides the port at runtime is `expo-dev-menu`, which reconnects
`RCTPackagerConnection` to the host and port of the bundle URL the app **context launched with**.
Deep linking a *running* app moves the bundle but leaves the packager socket on the old Metro,
and then `r` to reload and the dev menu are silently dropped while everything else looks fine.

So `pointDevClient` terminates the app and lets `simctl openurl` cold start it. Launching first
and deep linking afterwards is the obvious ordering and it is wrong.

It also avoids a second problem: `simctl openurl` blocks until the app answers, so opening a URL
against an app that is mid cold launch is what produces `NSPOSIXErrorDomain code=60`. Against a
terminated app it returns immediately.

**The check that matters**: foreground the app, press `r` in Metro, and confirm a *new*
`iOS Bundled ... (1 module)` line appears. Silence means the packager socket is on someone else's
Metro, and every other signal will still look right. A backgrounded app is also silent, so
foreground it first.

## `EXDevLauncherTryToLaunchLastBundle` lives in the app container

Writing it with `simctl spawn <udid> defaults write <bundleId> ...` targets the **device level**
preferences domain. The dev launcher reads the **app container** domain. The two disagree and the
container wins:

```
data/Library/Preferences/<bundleId>.plist                        -> false
data/Containers/Data/Application/<uuid>/Library/Preferences/
    <bundleId>.plist                                             -> true
```

The container copy is the real one; it also holds `expo.devlauncher.recentlyopenedapps` and the
`EXDevMenu*` keys. Write it with `PlistBuddy` at
`$(simctl get_app_container <udid> <bundleId> data)/Library/Preferences/<bundleId>.plist`, with
the app terminated.

Without it a cold start reopens whichever bundle that simulator saw last, which may be another
worktree's Metro or another project's entirely, and *that* becomes the app context.

**`simctl install` wipes the container**, so this has to be re-asserted after every install.

## The "Open in ...?" prompt is a device level record

`<device>/data/Library/Preferences/com.apple.launchservices.schemeapproval.plist`, a flat dict:

```
"com.apple.CoreSimulator.CoreSimulatorBridge-->myapp-dev" = "com.example.myapp.dev"
```

The caller for `simctl openurl` is always `com.apple.CoreSimulator.CoreSimulatorBridge`, so the
key is predictable from the scheme. It lives under `data/`, so it survives a clone, and it is
device level, so it survives an app reinstall. That is what lets one bake spare every future
worktree the prompt.

Write it while the device is **shut down**. A booted `cfprefsd` holds the domain in memory and
flushes its own copy back over yours.

Two tooling notes: `defaults read <absolute path>` does not work on macOS 26, and `plutil` treats
`.` as a key path separator so these dotted keys need escaping. `PlistBuddy`'s `:"..."` form
handles both. `Add` fails when the key exists and `Set` fails when it does not, so run both and
ignore the exit code.

## `expo run:ios` exits non-zero after a successful build

It ends by opening the app, and that step fails on its own terms: `simctl openurl` against an app
that is mid cold launch times out with `NSPOSIXErrorDomain code=60`. By then `Build Succeeded` has
already printed and the `.app` is installed.

So the exit code does not answer "did the build work". What is installed does. Check
`simctl get_app_container` before calling it a build failure, or a bake dies on the one step whose
result is thrown away anyway, since the dev client has to be cold started on the deep link
regardless.

## Names are decoration, UDIDs are identity

`xcrun simctl clone <src> <name>` does **not** fail when the name already exists. It silently
creates a duplicate. Name lookup is also substring matching, so `simctl list devices "iPhone 17"`
returns `iPhone 17 Pro`, `iPhone 17 Pro Max`, `iPhone 17e` and both real `iPhone 17`s.

Every new device's UDID is therefore captured by set difference of `simctl list devices --json`
taken before and after, under the state lock. Everything afterwards passes a UDID.

The `simwt-` name prefix is the fence that keeps `sweep` away from real simulators. Gate on it
before any destructive call.

## Runtime identifiers are not unique either

Two Ready runtimes can share one identifier: iOS 26.0 and 26.0.1 both report
`com.apple.CoreSimulator.SimRuntime.iOS-26-0`. `simctl create` given only the identifier picks
between them without saying which. Resolve by version and build and pass the `.simruntime`
**bundle path**.

A runtime can also go `Unusable` in place, for example when an Xcode update registers a duplicate.
Filter templates on the runtime still being `Ready`.

You cannot clone across runtimes: the clone re-resolves the source's device type and runtime and
fails if either is gone. One template per (device type, runtime build).

## Cloning is copy-on-write

Measured: cloning a 1.6 GB template consumed **7.5 MB** of container free space and took 6
seconds. So a fat, fully baked template is cheaper than a thin one plus a per worktree install,
and there is no reason to share a simulator between worktrees.

Note that `dataPathSize` reports apparent size, so `simwt status` shows a fresh clone as the full
template size. The disk does not actually hold that.

## A path existing is not a live worktree

There are half created worktree directories on this machine holding a single subdirectory. The
test is `git -C <path> rev-parse --show-toplevel` succeeding.

And absence of evidence is not evidence of death. If the project a simulator belongs to is not
visible right now, because Orca is closed or a volume is not mounted, `sweep` reports `unknown`
and leaves it alone. Only positive evidence justifies deleting.

## An installed app is not proof that a build ran

`expo run:ios` exits non-zero on a launch it could not open as well as on a build that failed, so
the exit code alone cannot separate them. Neither can "is an app installed": one almost always is,
because the cache installs before the build and a worktree that has run once is never empty. Taken
as proof, a link error reads as a launch failure and the stale app left behind gets cached under
the new fingerprint, which then spreads. Compare the installed bundle's mtime across the build and
ask whether *this* build replaced it.

## A build is judged by its bundle, not its exit code

The pod install below fails silently: `expo run:ios` exits zero, the app installs, and it caches
like any other. It only dies in dyld at launch, on whichever worktree installs it next, so one bad
install reaches every worktree sharing that fingerprint. `missingFrameworks` reads the `@rpath`
loads out of the binaries and checks `Frameworks/` carries them, which is why nothing is cached or
installed without that check.

That install also leaves `Manifest.lock` and `Podfile.lock` agreeing, so a matching pair is not
evidence the pods are sound. `--build` forces the two passes rather than trusting it.

## pod install runs twice

On SDK 57 the first `pod install` after a Podfile change can leave `React.framework` out of the
embed script, which crashes the app in dyld at launch. CocoaPods also aborts on these projects
unless `LANG`/`LC_ALL` are UTF-8.

## Bundle id and scheme come from the resolved Expo config

Never from `app.json`. Build variants rewrite both, and the Expo CLI's own
`resolveExpoOrLongestScheme` picks the **longest** iOS scheme, which on these apps is an OAuth
redirect scheme the dev client does not answer on. Read `ios.bundleIdentifier` and the first
`scheme` out of `expo config --type public --json`.

The dev client also answers on `exp+<slug>`, so the template approves that too.

## @expo/fingerprint is resolved from the project

Repos pin different versions and the hash is not stable across them. Borrowing simwt's copy would
quietly disagree with both EAS and the repo's own build cache.

## A template name has to carry its project

`pickTemplate` will only ever clone a template baked for the same project, so the name has to be
project scoped too. Named for the device and runtime alone, every repo competes for one name:
baking in one deletes the other's template, and that project's next worktree quietly comes up bare
with `templateUdid: null` and no app installed.

## Other

- `expo run:ios` has `--port` and `--no-bundler` mutually exclusive on SDK 57.
- `simctl shutdown` on an already shut down device exits non-zero; that is not a failure.
- `simctl bootstatus` can return while the device is still transitioning, so a call that follows
  fails with `Unable to lookup in current state` (405) rather than on its own merits.
- `simctl delete` leaves `~/Library/Logs/CoreSimulator/<udid>` and the host
  `com.apple.iphonesimulator` `DevicePreferences[<udid>]` entry behind.
- Orca terminal titles are set by whatever runs in them, so a recorded handle is the only stable
  way back to a Metro tab.
- `expo start` advertises `_expo._tcp` on the LAN with the app name, slug, both bundle ids and the
  Expo username, and it defaults to on: `EXPO_UNSTABLE_BONJOUR` falls back to `!envIsHeadless()`
  despite the name. `--offline` does not stop it, because mDNS is multicast rather than `fetch`.
  `cli.ts` sets `EXPO_UNSTABLE_BONJOUR=0` and `EXPO_OFFLINE=1` on the process, and `metro.ts`
  repeats them inline for the Orca tab, which Orca creates rather than inherits.
