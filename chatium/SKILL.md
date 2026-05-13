---
name: chatium
description: Work safely in Chatium projects that are already synchronized by the Chatium VS Code extension. Use when the assistant (Codex, Claude Code, or any other agent) reads, searches, plans, or edits local files under VS Code globalStorage/chatium.chatium-sync account folders, must pull external Chatium changes before inspecting project source, create a local git baseline, and publish local file changes back to Chatium through existing entity APIs. Do not use outside a folder already synced by the VS Code extension.
---

# Chatium

## Overview

Use this skill only inside a project folder that was opened and synchronized by the Chatium VS Code extension. The skill never changes Chatium backend behavior and never tries to read VS Code SecretStorage.

The skill is agent-agnostic. It is shipped for both Codex (via `agents/openai.yaml`) and Claude Code (via the standard `~/.claude/skills/chatium/SKILL.md` skill loader). The exact same helper script and rules apply in both environments.

## Required Workflow

Run the TypeScript helper with `tsx`:

```bash
npx -y tsx /path/to/chatium/scripts/chatium-sync.ts <command> --cwd "$PWD"
```

On Windows PowerShell use `${PWD}` instead of `"$PWD"`.

Always start with `begin` before reading, searching, opening, planning, or
editing project source files in a Chatium-synced project. `begin` verifies that
the current folder belongs to a VS Code Chatium sync root, pulls the latest
server code, refreshes generated typings in `node_modules`, initializes the
local git baseline when needed, and creates the task baseline.

Do not run `doctor` or `init` proactively on every request. Use them only to
recover from an explicit `begin` failure:

- If `begin` says the project must be opened through the Chatium VS Code
  extension first, stop source inspection and help the user fix that sync setup.
- If `begin` says Chatium auth is not initialized, run `init` once for that
  synced account folder, then rerun `begin`.
- If `begin` reports a Chatium sync conflict, stop before planning or editing
  and ask the user how to resolve it.

After `begin` succeeds:

1. Make the requested local code changes.
2. Run the smallest relevant validation.
3. Run `finish` after local changes are complete.

After this skill triggers, treat source inspection as planning. Do not run
`rg`, `sed`, `cat`, `ls`, open component files, inspect tests, or otherwise
read project source before `begin` succeeds. The only allowed pre-`begin`
actions are reading this skill and running `begin`; run `doctor` or `init` only
when needed to handle the specific `begin` error.

## Recovering from finish conflicts

If `finish` fails with `Cannot reapply stashed local changes over latest server version`:

1. Do not upload local changes.
2. Inspect the conflicted files reported by git.
3. Ask the user how to resolve the conflict based on the current server version and the intended task change.
4. After the conflict is resolved, run the smallest relevant validation and then run `finish` again.

If `finish` fails with `cannot reapply local changes over server version`:

1. Do not retry `finish` immediately.
2. Inspect the current file on disk and the saved `.chatium/conflicts/.../local.patch` (legacy name: `codex.patch`).
3. Treat the current file on disk as the latest server version.
4. Run `pull` to refresh Chatium sync checksums.
5. Re-apply only the intended user change on top of the current server version. Preserve server-side edits.
6. Run the smallest relevant validation for changed files.
7. Run `finish` again.

Do not apply the entire saved patch blindly when the conflict is on the same line. Reconstruct the user-intended change over the latest server text.

If the intended resolution is ambiguous, stop and ask the user how exactly to resolve the conflict before editing the file. Do not guess between competing valid resolutions.

## Command Behavior

- `doctor`: verifies that `--cwd` is inside the VS Code globalStorage Chatium sync directory for the current OS and that `configs/<accountKey>/tree.json` exists.
- `init`: runs the same preflight, prompts the user for a token, saves it locally, and excludes `.chatium/` from git.
- `pull`: downloads safe remote changes using the existing Chatium API and updates the VS Code extension `tree.json`.
- `typings`: recreates generated `node_modules` typings from the Monaco docs endpoint and writes generated `tsconfig.json` / `package.json` when the backend returns them.
- `begin`: runs `pull`, initializes git in the sync root if needed, excludes local system paths, runs `typings`, and creates a baseline commit.
- `finish`: stashes local task changes, runs `pull`, creates a new baseline commit for the latest server code, reapplies the stash, and uploads only the diff from that new baseline. If the stash cannot be applied cleanly, it keeps the stash and stops without uploading.

The VS Code globalStorage root is resolved per OS:

- macOS: `~/Library/Application Support/Code/User/globalStorage/chatium.chatium-sync`
- Windows: `%APPDATA%\Code\User\globalStorage\chatium.chatium-sync`
- Linux: `~/.config/Code/User/globalStorage/chatium.chatium-sync`

All commands must fail outside a VS Code extension synced folder with:

```text
Open this project through the Chatium VS Code extension first.
```

## Safety Rules

- Treat `<syncRoot>/.chatium/` as local-only data. Never sync it to Chatium and never commit it.
- Treat `node_modules/`, `tsconfig.json`, and `package.json` as generated local-only files. They are refreshed from the Monaco docs endpoint and must not be uploaded as Chatium source files.
- Never print the token after `init`.
- Never read VS Code SecretStorage or `state.vscdb` token blobs.
- Stop on pre-existing both-changed conflicts before making user-requested edits.
- If final stash reapply fails, keep the conflicted worktree and the stash, do not upload, and ask the user how to resolve the conflict.
- If `finish` cannot reapply local changes on top of a newer server file, keep the server file on disk, save conflict artifacts under `.chatium/conflicts/`, and report the path.

## Installation

- **Codex**: the `agents/openai.yaml` file is recognised by Codex when the skill folder is placed in a Codex-discoverable skills location.
- **Claude Code**: copy or symlink the `chatium/` folder into `~/.claude/skills/chatium/` (the folder that already contains `SKILL.md`). Claude Code auto-loads skills from there.

## Reference

Read `references/chatium-sync-protocol.md` when changing the helper script or when debugging API behavior.
