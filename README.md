# pi-git-guard

![release-watch](https://github.com/keen99/pi-git-guard/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-git-guard?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-git-guard/releases)

A [pi](https://pi.dev) extension that stops the agent from running destructive git commands via the `bash` tool without asking. `git revert` is the poster child — LLMs reach for it to "undo" things and quietly rewrite shared history — but the default blocklist covers the whole risk class.

## Why

`git revert` looks like "undo" to a model. It isn't. It rewrites history, can clobber commits, and on shared branches the damage spreads on the next pull. The same goes for `reset --hard`, force pushes, `clean -fd`, and friends.

`pi-git-safe-write` gates file writes. It does not touch the `bash` tool, so a `git revert` issued through bash sails straight through. This extension closes that gap.

## Decision matrix

| Command                                              | Behavior                  |
|------------------------------------------------------|---------------------------|
| `git revert ...`                                     | prompt (or block)         |
| `git reset --hard ...`                               | prompt (or block)         |
| `git push --force` / `--force-with-lease` / `-f`     | prompt (or block)         |
| `git push --delete ...`                              | prompt (or block)         |
| `git clean -fd` / `-fdx` / `-d` / `-x`               | prompt (or block)         |
| `git checkout -- .` / `git checkout .` / `git restore .` | prompt (or block)     |
| `git branch -D ...`                                  | prompt (or block)         |
| `git rm -r ...`                                      | prompt (or block)         |
| `git show HEAD:path > path` / any git command whose output redirects onto its own path arg | prompt when target is dirty (working-tree overwrite) |
| Everything else (`commit`, `add`, `merge`, `rebase`, `pull`, `fetch`, `stash`, ...) | allow |

## Modes

- **prompt** (default) — ask the user Yes (once) / Yes (session) / No when a destructive command is detected. With no UI, the call is blocked with a hint to use `/gitunsafe`.
- **block** — refuse destructive commands outright. User must `/gitunsafe` first, then re-run.

Toggle with `/gitguard-mode prompt` or `/gitguard-mode block`.

## Commands

| Command                    | Effect                                                                 |
|----------------------------|------------------------------------------------------------------------|
| `/gitunsafe`               | Disable the gate for the rest of the session. Persists across `/reload`; resets on `/new` / `/fork`. |
| `/gitsafe`                 | Re-enable the gate.                                                    |
| `/gitguard-mode prompt`    | Prompt on destructive commands (default).                              |
| `/gitguard-mode block`     | Hard-block destructive commands until `/gitunsafe`.                    |
| `/gitguard-mode`           | Show the current mode.                                                 |
| `/nogitguard`              | Disable the entire extension until restart (not persisted).            |

## Detection

The extension inspects the raw `command` string passed to the `bash` tool. It matches the destructive subcommands anywhere in the command (after stripping leading `sudo`/`env` prefixes and common shell wrappers), so it catches `git revert HEAD`, `cd foo && git revert HEAD~1`, `sudo git push -f`, compound commands, etc.

It does not parse shell quoting beyond what's needed to find the git subcommand and its flags. False positives are preferable to a silently rewritten branch.

## Install

### As a pi package

```bash
# ssh
pi install git:git@github.com:keen99/pi-git-guard

# public (https)
pi install git:github.com/keen99/pi-git-guard
```

### Manual / project-local

Drop `index.ts` into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local) and `/reload`.

## Requirements

- Pi with the `bash` tool and `tool_call` extension hook.
- No `git` binary required — the gate inspects command strings, not repo state.

## State

Approval, mode, and bypass are stored as custom session entries, so they survive `/reload`. They reset on `/new` and `/fork` because those start fresh sessions.

## Development

```sh
npm run check       # typecheck + unit tests (fake pi, real git in temp repos)
npm run test:matrix # deep smoke on every published pi release >= 0.75.0
```

The matrix boots each pinned pi release in RPC mode with the extension
loaded and asserts session_start + command registration on the real
process. tool_call gating logic is exercised by the unit tests with the
real handler. Cached installs live in `.matrix-cache/` and are reused
across runs; new pi releases are picked up automatically.

`PI_TEST_BIN` overrides the pi binary in the smoke test. Tests use
synthetic sessions in temp dirs; never touches real sessions.

## License

MIT
