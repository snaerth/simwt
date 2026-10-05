# simwt

One iOS simulator per git worktree, cloned from a golden template.

Every worktree gets its own simulator, created when the worktree is created and deleted when it
is archived. Because the clone is copy-on-write there is no reason to share a device between
worktrees, which removes the slot claiming, the takeover flags and the device selection ladder
that sharing needs.

## Install

```sh
cd ~/projects/simwt
bun install
bun link
```

That puts `simwt` on `PATH` at `~/.bun/bin/simwt`, pointing at this working tree, so `git pull`
is the whole update path.

## Use

```sh
simwt up [app]        # bring this worktree up and run Metro
simwt down [app]      # stop this worktree's detached Metro
simwt status          # every simwt simulator on this machine
simwt doctor          # check the machine and this project
simwt sweep           # reclaim simulators whose worktree is gone (dry run by default)
simwt gc --all        # shrink simulators in place by pruning their caches
simwt clean --native  # discard this project's cached builds and generated ios/ (dry run)
simwt template bake   # bake the template that worktrees clone
```

`simwt create` and `simwt warm` are the worktree setup hooks and `simwt destroy` the archive hook,
so none of them are usually run by hand.

`warm` boots the simulator, shows it in Orca's mobile emulator tab, installs the app from the
build cache, starts Metro in its own Orca tab and opens the app on it. **Metro's logs are in that
tab**, titled `metro:<app>:<port>`. `simwt down` closes it.

Metro runs with Bonjour advertising and Expo's dev-session ping turned off, so a worktree's dev
server does not show up in anyone else's dev client. See [docs/invariants.md](docs/invariants.md).

It never builds, because Orca kills a hook at two minutes. On a cache miss it says so and leaves
the app for `simwt up`, which may build.

Pass `--no-launch` to warm without starting Metro. Worth doing if you keep many worktrees open at
once, since otherwise each one gets its own Metro process.

## Per project config

A `simwt.json` at the repo root:

```json
{
  "defaultApp": "customer",
  "device": "iPhone 17",
  "warmOnCreate": ["customer"],
  "apps": {
    "customer": { "dir": "apps/customer" },
    "admin": { "dir": "apps/admin" }
  }
}
```

A repo with a single Expo app at its root needs no file at all. A repo that is not an Expo
project at all is detected as such, and `create` and `destroy` do nothing, so the same hook text
is safe in every repo.

Optional `runtime`, as `version` or `version/build`, pins which runtime `template bake` uses.
Pin the build when two Ready runtimes share a version.

## Orca worktree hooks

Set these in Orca's settings, under Worktree Hooks. They only do anything on a machine that has
simwt installed, so they belong to the machine rather than the repo.

Setup Script:

```sh
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v simwt >/dev/null 2>&1 && simwt create --worktree "${ORCA_WORKTREE_PATH:-$PWD}" --quiet || true
bun install
command -v simwt >/dev/null 2>&1 && simwt warm --budget 80 --quiet || true
```

Archive Script:

```sh
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v simwt >/dev/null 2>&1 && simwt destroy --worktree "${ORCA_WORKTREE_PATH:-$PWD}" --quiet
true
```

The same text can go in a committed `orca.yaml` under `scripts.setup` and `scripts.archive`, to
share it with a team. Note that a non-empty Setup Script in Orca's settings **overrides** the
committed one, so clear the settings field if you go that way.

Orca runs hook scripts through bash with a 120 second timeout, which is why `create` does only
the clone and `warm` takes a budget and never builds. `create` runs before `bun install` because
it needs neither `node_modules` nor the network.

See [docs/invariants.md](docs/invariants.md) for the things that are easy to get wrong.
