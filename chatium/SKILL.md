---
name: chatium
description: Work safely in Chatium projects that are already synchronized by the Chatium VS Code extension. Use when the assistant (Codex, Claude Code, or any other agent) reads, searches, plans, or edits local files under VS Code globalStorage/chatium.chatium-sync account folders, may inspect local source read-only before starting, must run begin before edits to refresh the server baseline, and publishes local file changes back to Chatium through existing entity APIs. Do not use outside a folder already synced by the VS Code extension.
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

You may read, search, and open project source files before `begin` for
orientation, answering read-only questions, or deciding what work is needed.
Treat this as an unrefreshed local snapshot. Do not edit source files, run
`finish`, or rely on that snapshot as the latest server state until `begin`
succeeds. There is no separate `continue` command. If the user asks for
follow-up edits after reviewing a previous result, run `begin` again before
changing files.

The core safety rule is: never lose current uncommitted local changes. `begin`
always stashes current local changes, pulls the latest Chatium server code,
refreshes generated typings in `node_modules`, creates a local git baseline
commit from the refreshed server state, then reapplies the stash. If a dirty git
file already matches the Chatium synced checksum, `begin` preserves that local
patch outside the baseline while still merging newer server-only edits into the
baseline. Current local changes remain uncommitted after `begin`.

After making the requested local code changes, run `finish`. `finish` first
records the task changes relative to the stored Chatium baseline, then stashes
current local changes, pulls the latest Chatium server code, creates a local
git baseline commit from the refreshed server state, reapplies the stash, and
uploads the recorded task changes to Chatium. This still uploads changes that
were already placed into local git commits after `begin`. Dirty files that
already match the Chatium synced checksum are skipped instead of uploaded
again. Any still-uncommitted local changes must remain uncommitted in the
worktree so the user can inspect or request further edits. Changes already
committed locally stay committed locally, but are still uploaded. If the user
requests further edits after `finish`, run `begin` again; it will preserve the
existing uncommitted changes before refreshing the baseline.

Do not run `doctor` or `init` proactively on every request. Use them only to
recover from an explicit `begin` or `finish` failure:

- If `begin` or `finish` says the project must be opened through the Chatium VS Code
  extension first, stop the Chatium sync workflow and help the user fix that setup.
- If `begin` or `finish` says Chatium auth is not initialized, run `init` once
  for that synced account folder, then rerun the original start command.
- If `begin` or `finish` reports a Chatium sync conflict, stop before editing
  and ask the user how to resolve it.

After `begin` succeeds:

1. Re-check any source files whose exact contents matter if they were inspected before `begin`.
2. Make the requested local code changes.
3. Run the smallest relevant validation.
4. Run `finish` after local changes are complete.

Before `begin`, keep source inspection read-only. It is fine to run `rg`,
`sed`, `cat`, `ls`, open component files, and inspect tests, but do not make
source edits or perform upload steps until `begin` succeeds. Run `doctor` or
`init` only when needed to handle a specific `begin` or `finish` error.

If `begin` fails with `Cannot reapply stashed local changes after begin refresh`,
do not keep editing. Inspect the conflicted files reported by git and ask the
user how to resolve the local task changes against the refreshed server version.

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

Workflow commands:

- `begin`: initializes git in the sync root if needed, excludes local system paths, stashes current local changes, runs `pull`, runs `typings`, creates a baseline commit for the latest server code, and reapplies the stash so local changes stay uncommitted. Already-synced dirty git files stay visible in `git diff`; newer server edits in those same files are merged into the baseline when possible.
- `finish`: records task changes relative to the stored Chatium baseline, stashes local task changes, runs `pull`, creates a new baseline commit for the latest server code, reapplies the stash, and uploads the recorded task changes. This includes task changes that were already committed locally after `begin`. It skips dirty files that already match the Chatium `syncedChecksum`, leaving them visible in the worktree for review. Already-synced dirty git files use the same baseline-preserving server merge as `begin`. If the stash cannot be applied cleanly, it keeps the stash and stops without uploading.

Support commands, only for recovery or debugging:

- `doctor`: verifies that `--cwd` is inside the VS Code globalStorage Chatium sync directory for the current OS and that `configs/<accountKey>/tree.json` exists.
- `init`: runs the same preflight, prompts the user for a token, saves it locally, and excludes `.chatium/` from git.
- `pull`: downloads safe remote changes using the existing Chatium API and updates the VS Code extension `tree.json`.
- `typings`: recreates generated `node_modules` typings from the Monaco docs endpoint and writes generated `tsconfig.json` / `package.json` when the backend returns them.

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
