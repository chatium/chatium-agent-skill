---
name: chatium
description: Work safely in Chatium projects that are already synchronized by the Chatium VS Code extension. Use when Codex edits local files under VS Code globalStorage/chatium.chatium-sync account folders, needs to pull external Chatium changes before editing, create a local git baseline, and publish local file changes back to Chatium through existing entity APIs. Do not use outside a folder already synced by the VS Code extension.
---

# Chatium

## Overview

Use this skill only inside a project folder that was opened and synchronized by the Chatium VS Code extension. The skill never changes Chatium backend behavior and never tries to read VS Code SecretStorage.

## Required Workflow

Run the TypeScript helper with `tsx`:

```bash
npx -y tsx /path/to/chatium/scripts/chatium-sync.ts <command> --cwd "$PWD"
```

Always run:

1. `doctor` when you need to inspect whether the folder is a valid Chatium sync root.
2. `init` once per synced account folder to store the user-provided token in `<syncRoot>/.chatium/codex-auth.json`.
3. `begin` before editing files for the user.
4. Make the requested local code changes.
5. `finish` after local changes are complete.

Do not run `begin`, `pull`, or `finish` if `init` has not stored auth yet.

## Recovering from finish conflicts

If `finish` fails with `cannot reapply local changes over server version`:

1. Do not retry `finish` immediately.
2. Inspect the current file on disk and the saved `.chatium/conflicts/.../codex.patch`.
3. Treat the current file on disk as the latest server version.
4. Run `pull` to refresh Chatium sync checksums.
5. Re-apply only the intended user change on top of the current server version. Preserve server-side edits.
6. Run the smallest relevant validation for changed files.
7. Run `finish` again.

Do not apply the entire saved patch blindly when the conflict is on the same line. Reconstruct the user-intended change over the latest server text.

If the intended resolution is ambiguous, stop and ask the user how exactly to resolve the conflict before editing the file. Do not guess between competing valid resolutions.

## Command Behavior

- `doctor`: verifies that `--cwd` is inside `~/Library/Application Support/Code/User/globalStorage/chatium.chatium-sync/<accountKey>` and that `configs/<accountKey>/tree.json` exists.
- `init`: runs the same preflight, prompts the user for a token, saves it locally, and excludes `.chatium/` from git.
- `pull`: downloads safe remote changes using the existing Chatium API and updates the VS Code extension `tree.json`.
- `begin`: runs `pull`, initializes git in the sync root if needed, excludes local system paths, and creates a baseline commit.
- `finish`: uploads changes since the baseline commit and retries one-file conflicts by applying Codex changes over the latest server version.

All commands must fail outside a VS Code extension synced folder with:

```text
Open this project through the Chatium VS Code extension first.
```

## Safety Rules

- Treat `<syncRoot>/.chatium/` as local-only data. Never sync it to Chatium and never commit it.
- Never print the token after `init`.
- Never read VS Code SecretStorage or `state.vscdb` token blobs.
- Stop on pre-existing both-changed conflicts before making user-requested edits.
- If `finish` cannot reapply local changes on top of a newer server file, keep the server file on disk, save conflict artifacts under `.chatium/conflicts/`, and report the path.

## Reference

Read `references/chatium-sync-protocol.md` when changing the helper script or when debugging API behavior.
