<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>

<p align="center"><strong>This repository is a fork — <a href="#opencode-mem-this-fork">OpenCode MEM</a>.</strong>
Install it from a release or from source; installing from npm gives you upstream OpenCode.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### OpenCode MEM (this fork)

This repository is a **fork of [OpenCode](https://github.com/anomalyco/opencode)**, published as `gpt-mem/opencode-mem`.
The [Installation](#installation-upstream-opencode) section below is upstream's: it installs **upstream OpenCode**.
`npm i -g @opencode/cli` — and the legacy `npm i -g opencode-ai` — install upstream, never this fork.

The fork ships two lines:

| Line | Branch              | Layout                           | Release tags                    |
| ---- | ------------------- | -------------------------------- | ------------------------------- |
| v1   | `memory-context-v1` | `packages/opencode`              | `mem-v<YYYYMMDD-HHMM>-<SHA>`    |
| v2   | `v2-base`           | `packages/core` + `packages/cli` | `mem-preview-<YYYYMMDD>-<slug>` |

#### Install from a release

Releases are published on the [releases page](https://github.com/gpt-mem/opencode-mem/releases).
A `mem-preview-*` tag ends with the source commit it was built from — `mem-preview-20261018-trim-web-serve-17355bd`
was built from `17355bd0dce18126cc73fc76c6d95ca52c0d647b`. Assets: `opencode-linux-x64.tar.gz` (with a
`.sha256` companion) and, when published, `opencode-darwin-arm64.tar.gz` (with a `.sha256` companion).
Each archive contains a single `opencode` executable.

```bash
TAG=mem-preview-20261018-trim-web-serve-17355bd
gh release download "$TAG" --repo gpt-mem/opencode-mem \
  --pattern "opencode-darwin-arm64.tar.gz*" --clobber
shasum -a 256 -c opencode-darwin-arm64.tar.gz.sha256      # sha256sum -c on Linux
tar -xzf opencode-darwin-arm64.tar.gz

mkdir -p "$HOME/.opencode/bin"
# keep the stock binary so the fork can always be undone
[ -f "$HOME/.opencode/bin/opencode.stock-backup" ] || \
  cp "$HOME/.opencode/bin/opencode" "$HOME/.opencode/bin/opencode.stock-backup"
# copy to a new name, then rename: replacing a running executable in place
# makes macOS SIGKILL every process that mapped it
cp opencode "$HOME/.opencode/bin/opencode.new" && chmod +x "$HOME/.opencode/bin/opencode.new"
mv -f "$HOME/.opencode/bin/opencode.new" "$HOME/.opencode/bin/opencode"
```

#### Install from source (v2 line)

Requires [Bun](https://bun.sh) `1.4.2` — the version pinned in `packageManager`.

```bash
git clone https://github.com/gpt-mem/opencode-mem.git
cd opencode-mem
git checkout v2-base
bun install

cd packages/cli
OPENCODE_CHANNEL=latest \
OPENCODE_VERSION="0.0.0-fork-at-$(git rev-parse --short=12 HEAD)" \
  bun run script/build.ts --single --skip-install --skip-web-ui
```

The executable lands in `packages/cli/dist/cli-<os>-<arch>/bin/opencode`
(`cli-darwin-arm64`, `cli-linux-x64`, `cli-windows-x64.exe`).
`OPENCODE_VERSION` embeds the built commit into the binary so `--version` names the exact build; without it the
version is taken from `packages/cli/package.json`.
`OPENCODE_CHANNEL` decides which **database file** the binary opens (`packages/cli/src/database-path.ts`):
`opencode.db` for the `latest|dev|beta|next|prod` channels, `opencode-<channel>.db` for anything else. Left unset,
the channel is taken from the branch name, so a build of `v2-base` opens `opencode-v2-base.db` — a database of its
own, with none of your credentials and none of your sessions in it. A fork build that **replaces** the upstream
binary has to share the upstream database, hence `OPENCODE_CHANNEL=latest`.
Check what a binary opens with:

```bash
opencode debug paths | grep ^db   # db …/opencode.db — the same file the upstream build opens
```

`--skip-web-ui` only skips the bundled web UI; `--target=opencode-linux-x64` builds a single foreign target.

#### Install a specific version, and roll back

Any commit is installable — check out the tag or the SHA and build as above:

```bash
git checkout mem-preview-20261018-trim-web-serve-17355bd   # by tag
git checkout 17355bd0dce18126cc73fc76c6d95ca52c0d647b      # by commit
```

Keep one backup per installed build next to the binary (`opencode.<sha>-<YYYYMMDDHHMM>.bak`) and roll back by
restoring it the same way a new build is installed:

```bash
cp "$HOME/.opencode/bin/opencode.<sha>-<YYYYMMDDHHMM>.bak" "$HOME/.opencode/bin/opencode.new"
chmod +x "$HOME/.opencode/bin/opencode.new"
mv -f "$HOME/.opencode/bin/opencode.new" "$HOME/.opencode/bin/opencode"
```

#### What gets installed, and where

Installing a fork build touches these paths. Nothing else is written, and nothing outside them is modified:

| Path                                | What it is                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `~/.opencode/bin/opencode`          | the executable your shell runs                                                          |
| `~/.opencode/bin/opencode.stock-backup` | the upstream binary, copied aside before the first fork install so the fork can be undone |
| `~/.opencode/builds/<sha12>/opencode` | one directory per installed fork build; `<sha12>` is the commit it was built from        |
| `~/.opencode/builds/current`        | symlink to the **last** installed build (the file, not the directory)                    |
| `~/.opencode/builds/previous`       | symlink to the build installed before `current`                                          |
| `~/.opencode/builds/order.txt`      | the build queue, oldest first; `rollback` walks strictly backwards through it             |
| `~/.opencode/forever-install.json`  | manifest of the active build: repository, revision, version, platform, sha256, install time |

Keeping every build in its own directory is what makes "last" and "previous" selectable at the same time:
`current` and `previous` are two pointers into the same queue, so switching between them never rebuilds or
reinstalls anything.

```bash
# after building (see above), install the result and shift the pointers
~/.opencode/scripts/mem-builds.sh install packages/cli/dist/cli-darwin-arm64/bin/opencode
~/.opencode/scripts/mem-builds.sh status     # current / previous, with versions
~/.opencode/scripts/mem-builds.sh rollback   # current ← the build before it, previous ← the one before that
~/.opencode/scripts/mem-builds.sh list       # every build on disk, the queue and the pointers
```

`install` derives the SHA from `opencode --version` (`fork-at-<sha>`), so a binary built with
`OPENCODE_VERSION` names its own commit. The Session Manager registers the two pointers as
`OpenCode last` and `OpenCode previous`, and the agent dropdown lists them between Codex and Claude.

#### Verify that the fork is installed

```bash
opencode --version
# opencode v0.0.0-fork-at-950f0d869b8d     ← source build: the built commit is in the version string
# opencode v0.0.0-<slug>-<timestamp>       ← release build
```

The install manifest records what is installed and where it came from:

```bash
cat ~/.opencode/forever-install.json
# { "revision": "<full commit SHA>", "version": "0.0.0-fork-at-<sha>", ... }
```

#### What the fork changes on the v2 line

Tool output above **2 KiB** leaves the model context by default and lands in a file instead, so a large result
costs a pointer rather than its full payload on every later step.

The provider cache-mark ledger and the Ladder cache mask are **on by default**; set the environment variable to
`0` to turn the mask off, and move the idle threshold that decides when a confirmed cache boundary counts as cold:

| Variable                      | Default  | Effect                                                                                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCODE_CACHE_MASK`         | on       | Project the message history for the Ladder provider so a stale cache boundary is re-warmed instead of resent. `0` disables it. |
| `OPENCODE_CACHE_MARK_IDLE_MS` | `600000` | Idle time after which a confirmed cache boundary is treated as cold.                                                           |

> The `OPENCODE_MEMORY_*` family (`OPENCODE_MEMORY_CONTEXT`, `OPENCODE_MEMORY_INTENT`, …) belongs to the **v1**
> line (`memory-context-v1`). It does not exist on `v2-base`: the v2 line applies the context budget
> unconditionally instead of behind a flag.

### Installation (upstream OpenCode)

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g @opencode/cli@latest      # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
