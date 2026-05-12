# Chatium Sync Protocol Reference

This reference is derived from the current `chatium-sync` VS Code extension.

## Local Layout

The skill only works inside a folder already synchronized by the VS Code extension. The VS Code globalStorage root is resolved per OS:

- macOS: `~/Library/Application Support/Code/User/globalStorage/chatium.chatium-sync`
- Windows: `%APPDATA%\Code\User\globalStorage\chatium.chatium-sync`
- Linux: `~/.config/Code/User/globalStorage/chatium.chatium-sync`

The synced project folder is `<storageRoot>/<accountKey>` and the extension keeps sync metadata separately at `<storageRoot>/configs/<accountKey>/tree.json`.

For account keys with a path suffix, the source folder uses the extension convention:

```text
accountKey.replace('/', '.')
```

The config folder keeps the slash path under `configs/`.

The helper script also honors the `CHATIUM_STORAGE_ROOT` environment variable for non-default VS Code installations (Insiders, VSCodium, portable installs).

## Local Skill Files

The skill stores local-only data in:

```text
<syncRoot>/.chatium/
```

This path is ignored by the extension sync logic and must be excluded from git. It contains:

- `auth.json` (legacy: `codex-auth.json`): user-provided token.
- `state.json` (legacy: `codex-state.json`): baseline commit information.
- `conflicts/`: saved conflict artifacts (`local.patch`, legacy: `codex.patch`).

The script reads either the new or legacy filename, so existing installs keep working.

## System Paths

Never upload or inspect these as Chatium source files:

- `.chatium`
- `.vscode`
- `.git`
- `tsconfig.json`
- `.gitignore`
- `node_modules`
- `package.json`
- `*.DS_Store`

## Auth

Existing entity APIs accept the token as a cookie:

```http
Cookie: apiToken=<token>
```

When available, also send the stored backend session id:

```http
x-chatium-unique-id: <backendSessionId>
```

The skill must not read VS Code SecretStorage. The user provides the token manually during `init`.

## Tree File

`tree.json` stores:

- `items`: map from account path to entity metadata.
- `filePutUrl`: upload endpoint for binary file service content.
- `socketBaseUrl`, `debugSocketId`: debug socket data.
- `backendSessionId`: session id from backend cookie.
- `lastSyncedAt`, `savedAt`: timestamps.

Each item contains:

- `id`
- `slug`
- `path`
- `checksum`
- `parentId`
- `entityType`
- `isDirectory`
- `state`
- `syncedChecksum`

## Pull Rules

Compare `remoteChecksum`, `localChecksum`, and `syncedChecksum`.

- Missing local file or no local item: download remote file.
- `localChecksum === remoteChecksum`: mark synced.
- `localChecksum === syncedChecksum`: remote changed only, download remote file.
- `remoteChecksum === syncedChecksum`: local changed only, do not download.
- Otherwise: both changed, stop and ask for manual resolution.

## API Endpoints

All URLs are resolved against:

```text
https://<accountKey>
```

Endpoints:

- `GET /s/entity/get-tree`
- `GET /s/entity/get-code/:id`
- `POST /s/entity/update-code`
- `POST /s/entity/delete`
- `POST /s/entity/rename`

`update-code` body:

```json
{
  "path": "path/to/file.tsx",
  "source": "file content",
  "checksum": "last synced checksum or omitted",
  "overwrite": false
}
```

If the backend returns `anotherVersion`, fetch the latest server file, apply local changes over it, then retry with the latest remote checksum.
