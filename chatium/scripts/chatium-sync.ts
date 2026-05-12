#!/usr/bin/env -S npx tsx

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0'

const source = 'manual-user-provided-token'
const authFileName = 'codex-auth.json'
const stateFileName = 'codex-state.json'
const failureOpenInVscode = 'Open this project through the Chatium VS Code extension first.'
const baselineMessage = 'chatium baseline before codex work'
const finishStashMessage = 'chatium local changes before finish refresh'

type Entity = {
  id: string
  slug: string
  path: string
  checksum: string
  parentId: string | null
  entityType: string
  isDirectory: boolean
}

type EntityWithState = Entity & {
  state?: string
  syncedChecksum?: string
}

type TreeFile = {
  backendSessionId?: string
  debugSocketId?: string | null
  filePutUrl?: string
  items?: Record<string, EntityWithState>
  lastSyncedAt?: number
  savedAt?: number
  socketBaseUrl?: string
}

type AuthFile = {
  accountKey: string
  apiToken: string
  createdAt: string
  source: typeof source
}

type StateFile = {
  accountKey: string
  baselineCommit: string
  createdAt: string
}

type Env = {
  accountKey: string
  authPath: string
  configDir: string
  cwd: string
  statePath: string
  storageRoot: string
  syncRoot: string
  treePath: string
}

type RemoteTreeResponse = {
  success: boolean
  items: Entity[]
  filePutUrl?: string
  debugSocketId?: string | null
  socketBaseUrl?: string
}

type Change =
  | { status: 'A' | 'M' | 'D'; path: string }
  | { status: 'R'; oldPath: string; path: string }

type CliArgs = {
  command: string
  cwd: string
}

type FinishStash = {
  commit: string
  ref: 'stash@{0}'
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})

async function main() {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case 'doctor':
      return doctor(args)
    case 'init':
      return init(args)
    case 'pull':
      return pullCommand(args)
    case 'begin':
      return begin(args)
    case 'finish':
      return finish(args)
    case 'help':
    case '--help':
    case '-h':
      return printHelp()
    default:
      throw new Error(`Unknown command: ${args.command}\nRun with "help" for usage.`)
  }
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    command: argv[0] ?? 'help',
    cwd: process.cwd(),
  }

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--cwd') {
      result.cwd = requireValue(argv[++i], '--cwd')
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  result.cwd = path.resolve(result.cwd)
  return result
}

function printHelp() {
  console.log(`Usage:
  npx -y tsx chatium/scripts/chatium-sync.ts doctor [--cwd DIR]
  npx -y tsx chatium/scripts/chatium-sync.ts init [--cwd DIR]
  npx -y tsx chatium/scripts/chatium-sync.ts pull [--cwd DIR]
  npx -y tsx chatium/scripts/chatium-sync.ts begin [--cwd DIR]
  npx -y tsx chatium/scripts/chatium-sync.ts finish [--cwd DIR]

Commands only work inside VS Code Chatium sync folders.`)
}

function defaultStorageRoot(): string {
  return path.join(homedir(), 'Library/Application Support/Code/User/globalStorage/chatium.chatium-sync')
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
}

function doctor(args: CliArgs) {
  const env = preflight(args)
  console.log(JSON.stringify(redactEnv(env), null, 2))
}

async function init(args: CliArgs) {
  const env = preflight(args)
  ensureLocalDir(env)
  ensureGitExcludeIfRepo(env.syncRoot)

  const rawToken = await readSecret('Paste Chatium api token: ')
  const parsed = parseProvidedToken(rawToken.trim())

  if (!parsed.apiToken) {
    throw new Error('Token is empty')
  }
  if (parsed.accountKey && parsed.accountKey !== env.accountKey) {
    throw new Error(`Token account ${parsed.accountKey} does not match current account ${env.accountKey}`)
  }

  const auth: AuthFile = {
    accountKey: env.accountKey,
    apiToken: parsed.apiToken,
    createdAt: new Date().toISOString(),
    source,
  }

  writeJson(env.authPath, auth)
  chmodSync(env.authPath, 0o600)
  console.log(`Saved Chatium auth for ${env.accountKey} at ${env.authPath}`)
}

async function pullCommand(args: CliArgs) {
  const env = preflight(args)
  const auth = readAuth(env)
  const tree = await pull(env, auth)
  console.log(`Pulled ${Object.keys(tree.items ?? {}).length} tracked Chatium item(s).`)
}

async function begin(args: CliArgs) {
  const env = preflight(args)
  const auth = readAuth(env)
  await pull(env, auth)

  ensureGitRepo(env.syncRoot)
  ensureGitExcludeIfRepo(env.syncRoot)
  const baselineCommit = createAndStoreBaseline(env)
  console.log(`Baseline commit: ${baselineCommit}`)
}

async function finish(args: CliArgs) {
  const env = preflight(args)
  const auth = readAuth(env)
  readState(env)
  ensureGitRepo(env.syncRoot)
  ensureGitExcludeIfRepo(env.syncRoot)

  const stash = stashLocalChanges(env)
  let baselineCommit: string

  try {
    await pull(env, auth)
    baselineCommit = createAndStoreBaseline(env)

    if (stash) {
      applyFinishStash(env, stash)
      dropFinishStash(env, stash)
    }
  } catch (error) {
    throw withPreservedStashMessage(error, stash)
  }

  const changes = getChangesSinceBaseline(env, baselineCommit)

  if (changes.length === 0) {
    console.log('No local changes since Chatium baseline.')
    return
  }

  const tree = readTree(env)
  const remote = await fetchRemoteTree(env, auth, tree)
  const remoteItems = mapRemoteItems(remote.body.items)
  saveTree(env, tree)

  for (const change of changes.filter((item): item is Extract<Change, { status: 'R' }> => item.status === 'R')) {
    await uploadRename(env, auth, tree, remoteItems, change)
  }

  for (const change of changes) {
    if (change.status === 'R') {
      const filePath = path.join(env.syncRoot, change.path)
      if (existsSync(filePath) && sha1File(filePath) !== tree.items?.[change.path]?.syncedChecksum) {
        await uploadFile(env, auth, tree, remoteItems, change.path, baselineCommit)
      }
    } else if (change.status === 'D') {
      await uploadDelete(env, auth, tree, remoteItems, change.path)
    } else {
      await uploadFile(env, auth, tree, remoteItems, change.path, baselineCommit)
    }
  }

  saveTree(env, tree)
  console.log(`Uploaded ${changes.length} change(s) to Chatium.`)
}

function preflight(args: CliArgs): Env {
  const storageRoot = defaultStorageRoot()

  if (!existsSync(storageRoot) || !statSync(storageRoot).isDirectory()) {
    throw new Error(failureOpenInVscode)
  }

  const configsRoot = path.join(storageRoot, 'configs')
  if (!existsSync(configsRoot)) {
    throw new Error(failureOpenInVscode)
  }

  const candidates = findTreeFiles(configsRoot).map(treePath => {
    const configDir = path.dirname(treePath)
    const accountKey = normalizePath(path.relative(configsRoot, configDir))
    const syncRoot = path.join(storageRoot, accountKey.replace('/', '.'))
    return { accountKey, configDir, syncRoot, treePath }
  })

  const current = normalizePath(args.cwd)
  const match = candidates
    .filter(candidate => existsSync(candidate.syncRoot))
    .filter(candidate => isInsideOrSame(current, normalizePath(candidate.syncRoot)))
    .sort((a, b) => b.syncRoot.length - a.syncRoot.length)[0]

  if (!match || !existsSync(match.treePath)) {
    throw new Error(failureOpenInVscode)
  }

  const localDir = path.join(match.syncRoot, '.chatium')

  return {
    accountKey: match.accountKey,
    authPath: path.join(localDir, authFileName),
    configDir: match.configDir,
    cwd: args.cwd,
    statePath: path.join(localDir, stateFileName),
    storageRoot,
    syncRoot: match.syncRoot,
    treePath: match.treePath,
  }
}

function findTreeFiles(dir: string): string[] {
  const result: string[] = []
  const entries = safeReaddir(dir)
  for (const entry of entries) {
    const fullPath = path.join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      result.push(...findTreeFiles(fullPath))
    } else if (entry === 'tree.json') {
      result.push(fullPath)
    }
  }
  return result
}

function safeReaddir(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : []
  } catch {
    return []
  }
}

function isInsideOrSame(child: string, parent: string): boolean {
  const rel = normalizePath(path.relative(parent, child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function redactEnv(env: Env) {
  return {
    accountKey: env.accountKey,
    cwd: env.cwd,
    syncRoot: env.syncRoot,
    treePath: env.treePath,
    authPath: env.authPath,
    authExists: existsSync(env.authPath),
  }
}

function ensureLocalDir(env: Env) {
  mkdirSync(path.dirname(env.authPath), { recursive: true })
}

function readAuth(env: Env): AuthFile {
  if (!existsSync(env.authPath)) {
    throw new Error(`Chatium auth is not initialized. Run "init" first.`)
  }
  const auth = readJson<AuthFile>(env.authPath)
  if (auth.accountKey !== env.accountKey) {
    throw new Error(`Auth account ${auth.accountKey} does not match current account ${env.accountKey}`)
  }
  if (!auth.apiToken) {
    throw new Error(`Auth file has no apiToken: ${env.authPath}`)
  }
  return auth
}

function readState(env: Env): StateFile {
  if (!existsSync(env.statePath)) {
    throw new Error(`Chatium baseline state is missing. Run "begin" first.`)
  }
  const state = readJson<StateFile>(env.statePath)
  if (state.accountKey !== env.accountKey) {
    throw new Error(`State account ${state.accountKey} does not match current account ${env.accountKey}`)
  }
  return state
}

async function pull(env: Env, auth: AuthFile): Promise<TreeFile> {
  const tree = readTree(env)
  const remote = await fetchRemoteTree(env, auth, tree)
  const remoteItems = mapRemoteItems(remote.body.items)
  const conflicts: string[] = []

  tree.items = tree.items ?? {}

  for (const [oldPath, oldItem] of Object.entries({ ...tree.items })) {
    if (isSystemPath(oldPath)) {
      continue
    }
    if (!remoteItems[oldPath]) {
      const localPath = path.join(env.syncRoot, oldPath)
      if (!existsSync(localPath)) {
        delete tree.items[oldPath]
        continue
      }
      if (!oldItem.isDirectory && oldItem.syncedChecksum && sha1File(localPath) === oldItem.syncedChecksum) {
        rmSync(localPath, { force: true, recursive: true })
        delete tree.items[oldPath]
      } else {
        conflicts.push(`${oldPath}: deleted on server but changed locally`)
      }
    }
  }

  for (const remoteItem of Object.values(remoteItems)) {
    const itemPath = remoteItem.path
    if (isSystemPath(itemPath)) {
      continue
    }

    const localPath = path.join(env.syncRoot, itemPath)
    const localItem = tree.items[itemPath]

    if (remoteItem.isDirectory) {
      mkdirSync(localPath, { recursive: true })
      tree.items[itemPath] = { ...remoteItem, state: 'synced', syncedChecksum: remoteItem.checksum }
      continue
    }

    if (!localItem || !existsSync(localPath)) {
      await downloadFile(env, auth, remoteItem.id, localPath)
      tree.items[itemPath] = { ...remoteItem, state: 'synced', syncedChecksum: remoteItem.checksum }
      continue
    }

    const localChecksum = sha1File(localPath)
    if (localChecksum === remoteItem.checksum) {
      tree.items[itemPath] = { ...remoteItem, state: 'synced', syncedChecksum: remoteItem.checksum }
    } else if (localItem.syncedChecksum === localChecksum) {
      await downloadFile(env, auth, remoteItem.id, localPath)
      tree.items[itemPath] = { ...remoteItem, state: 'synced', syncedChecksum: remoteItem.checksum }
    } else if (remoteItem.checksum === localItem.syncedChecksum) {
      tree.items[itemPath] = { ...remoteItem, state: 'needUpload', syncedChecksum: localItem.syncedChecksum }
    } else {
      tree.items[itemPath] = { ...remoteItem, state: 'changedLocally', syncedChecksum: localItem.syncedChecksum }
      conflicts.push(`${itemPath}: changed locally and on server`)
    }
  }

  tree.lastSyncedAt = Date.now()
  saveTree(env, tree)

  if (conflicts.length > 0) {
    throw new Error(`Chatium sync conflicts:\n${conflicts.map(item => `- ${item}`).join('\n')}`)
  }

  return tree
}

function readTree(env: Env): TreeFile {
  return readJson<TreeFile>(env.treePath)
}

function saveTree(env: Env, tree: TreeFile) {
  tree.savedAt = Date.now()
  writeJson(env.treePath, tree)
}

async function fetchRemoteTree(env: Env, auth: AuthFile, tree: TreeFile) {
  const response = await requestJson<RemoteTreeResponse>(env, auth, '/s/entity/get-tree', { method: 'GET' }, tree)
  if (!response.body.items) {
    throw new Error('Chatium get-tree response has no items')
  }
  tree.filePutUrl = response.body.filePutUrl ?? tree.filePutUrl
  tree.socketBaseUrl = response.body.socketBaseUrl ?? tree.socketBaseUrl
  tree.debugSocketId = response.body.debugSocketId ?? tree.debugSocketId
  const sessionId = parseSessionId(response.setCookie)
  if (sessionId) {
    tree.backendSessionId = sessionId
  }
  return response
}

function mapRemoteItems(items: Entity[]): Record<string, Entity> {
  return Object.fromEntries(items.filter(item => !isSystemPath(item.path)).map(item => [item.path, item]))
}

async function downloadFile(env: Env, auth: AuthFile, id: string, filePath: string): Promise<Entity | undefined> {
  const tree = readTree(env)
  const response = await requestJson<{ source: string; entity?: Entity }>(
    env,
    auth,
    `/s/entity/get-code/${encodeURIComponent(id)}`,
    { method: 'GET' },
    tree,
  )
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, response.body.source ?? '', 'utf8')
  return response.body.entity
}

async function uploadRename(
  env: Env,
  auth: AuthFile,
  tree: TreeFile,
  remoteItems: Record<string, Entity>,
  change: Extract<Change, { status: 'R' }>,
) {
  if (isSystemPath(change.oldPath) || isSystemPath(change.path)) {
    return
  }

  const localItem = tree.items?.[change.oldPath]
  const remoteItem = remoteItems[change.oldPath]
  if (!localItem || !remoteItem) {
    return
  }
  if (!remoteItem.isDirectory && remoteItem.checksum !== localItem.syncedChecksum) {
    throw new Error(`${change.oldPath}: changed on server before rename upload`)
  }

  const response = await requestJson<{ success: boolean; entities?: Entity[]; message?: string }>(
    env,
    auth,
    '/s/entity/rename',
    {
      method: 'POST',
      body: {
        files: [{ oldPath: change.oldPath, newPath: change.path }],
      },
    },
    tree,
  )

  if (!response.body.success) {
    throw new Error(response.body.message || `Failed to rename ${change.oldPath} to ${change.path}`)
  }

  delete tree.items?.[change.oldPath]
  for (const entity of response.body.entities ?? []) {
    tree.items![entity.path] = { ...entity, state: 'synced', syncedChecksum: entity.checksum }
  }
}

async function uploadDelete(
  env: Env,
  auth: AuthFile,
  tree: TreeFile,
  remoteItems: Record<string, Entity>,
  itemPath: string,
) {
  if (isSystemPath(itemPath)) {
    return
  }

  const localItem = tree.items?.[itemPath]
  const remoteItem = remoteItems[itemPath]
  if (remoteItem && localItem?.syncedChecksum && remoteItem.checksum !== localItem.syncedChecksum) {
    throw new Error(`${itemPath}: changed on server before delete upload`)
  }

  const response = await requestJson<{ success: boolean; message?: string }>(
    env,
    auth,
    '/s/entity/delete',
    {
      method: 'POST',
      body: {
        files: [{ path: itemPath }],
      },
    },
    tree,
  )

  if (!response.body.success) {
    throw new Error(response.body.message || `Failed to delete ${itemPath}`)
  }
  delete tree.items?.[itemPath]
}

async function uploadFile(
  env: Env,
  auth: AuthFile,
  tree: TreeFile,
  remoteItems: Record<string, Entity>,
  itemPath: string,
  baselineCommit: string,
) {
  if (isSystemPath(itemPath)) {
    return
  }

  const filePath = path.join(env.syncRoot, itemPath)
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    return
  }

  const localItem = tree.items?.[itemPath]
  const remoteItem = remoteItems[itemPath]
  if (!localItem && remoteItem) {
    await recoverAndRetryUpload(env, auth, tree, itemPath, filePath, baselineCommit, { entityId: remoteItem.id })
    return
  }

  const sourceText = await readUploadSource(env, auth, tree, filePath)
  const response = await requestJson<any>(
    env,
    auth,
    '/s/entity/update-code',
    {
      method: 'POST',
      body: {
        path: itemPath,
        source: sourceText,
        checksum: localItem?.syncedChecksum,
        overwrite: false,
      },
    },
    tree,
  )

  if (response.body?.success) {
    applyUpdatedEntity(env, tree, itemPath, filePath, response.body)
    return
  }

  if (response.body?.anotherVersion) {
    await recoverAndRetryUpload(env, auth, tree, itemPath, filePath, baselineCommit, response.body)
    return
  }

  throw new Error(response.body?.message || `Failed to upload ${itemPath}`)
}

async function recoverAndRetryUpload(
  env: Env,
  auth: AuthFile,
  tree: TreeFile,
  itemPath: string,
  filePath: string,
  baselineCommit: string,
  conflictBody: any,
) {
  const entityId = conflictBody.entityId
  if (!entityId) {
    throw new Error(`${itemPath}: server returned anotherVersion without entityId`)
  }

  const conflictDir = path.join(env.syncRoot, '.chatium', 'conflicts', `${Date.now()}-${safeName(itemPath)}`)
  mkdirSync(conflictDir, { recursive: true })

  const oursPath = path.join(conflictDir, 'ours')
  const basePath = path.join(conflictDir, 'base')
  const remotePath = path.join(conflictDir, 'remote')
  const mergedPath = path.join(conflictDir, 'merged')
  const patchPath = path.join(conflictDir, 'codex.patch')

  writeFileSync(oursPath, readFileSync(filePath))

  const base = git(env.syncRoot, ['show', `${baselineCommit}:${itemPath}`], { allowFailure: true })
  if (base.status !== 0) {
    writeFileSync(basePath, '')
    saveNoIndexPatch(basePath, oursPath, patchPath)
    const remoteEntity = await downloadFile(env, auth, entityId, filePath)
    if (remoteEntity) {
      tree.items = tree.items ?? {}
      tree.items[itemPath] = { ...remoteEntity, state: 'synced', syncedChecksum: remoteEntity.checksum }
      saveTree(env, tree)
    }
    throw new Error(`${itemPath}: cannot recover conflict for a file that did not exist at baseline. Patch saved to ${patchPath}`)
  }
  writeFileSync(basePath, base.stdout)

  const remoteEntity = await downloadFile(env, auth, entityId, remotePath)
  const merge = spawnSync('git', ['merge-file', '-p', oursPath, basePath, remotePath], {
    cwd: env.syncRoot,
    encoding: 'utf8',
  })

  if (merge.status !== 0) {
    writeFileSync(mergedPath, merge.stdout || '')
    saveNoIndexPatch(basePath, oursPath, patchPath)
    const latestRemoteEntity = await downloadFile(env, auth, entityId, filePath)
    if (latestRemoteEntity) {
      tree.items = tree.items ?? {}
      tree.items[itemPath] = { ...latestRemoteEntity, state: 'synced', syncedChecksum: latestRemoteEntity.checksum }
      saveTree(env, tree)
    }
    throw new Error(
      `${itemPath}: cannot reapply local changes over server version. Patch saved to ${patchPath}. Current file is the latest server version. Reapply the intended local edits and run finish again.`,
    )
  }

  writeFileSync(filePath, merge.stdout, 'utf8')
  if (remoteEntity) {
    tree.items![itemPath] = { ...remoteEntity, state: 'synced', syncedChecksum: remoteEntity.checksum }
  }

  const sourceText = await readUploadSource(env, auth, tree, filePath)
  const retry = await requestJson<any>(
    env,
    auth,
    '/s/entity/update-code',
    {
      method: 'POST',
      body: {
        path: itemPath,
        source: sourceText,
        checksum: tree.items?.[itemPath]?.syncedChecksum,
        overwrite: false,
      },
    },
    tree,
  )

  if (!retry.body?.success) {
    throw new Error(retry.body?.message || `${itemPath}: retry upload failed after conflict recovery`)
  }
  applyUpdatedEntity(env, tree, itemPath, filePath, retry.body)
}

function applyUpdatedEntity(env: Env, tree: TreeFile, itemPath: string, filePath: string, body: any) {
  if (!body.entity) {
    throw new Error(`${itemPath}: update-code response has no entity`)
  }
  tree.items = tree.items ?? {}
  tree.items[itemPath] = { ...body.entity, state: 'synced', syncedChecksum: body.entity.checksum }
  if (typeof body.source === 'string') {
    writeFileSync(filePath, body.source, 'utf8')
  }
  saveTree(env, tree)
}

async function readUploadSource(env: Env, auth: AuthFile, tree: TreeFile, filePath: string): Promise<string> {
  const buffer = readFileSync(filePath)
  if (looksUtf8(buffer)) {
    return buffer.toString('utf8')
  }

  if (!tree.filePutUrl) {
    throw new Error(`Cannot upload binary file without filePutUrl: ${filePath}`)
  }

  const form = new FormData()
  form.append('Filedata', new Blob([new Uint8Array(buffer)]), path.basename(filePath))
  const response = await fetch(tree.filePutUrl, { method: 'POST', body: form })
  if (!response.ok) {
    throw new Error(`File service upload failed with HTTP ${response.status}`)
  }
  const fileHash = (await response.text()).trim()
  const source = JSON.stringify({ fileHash })
  writeFileSync(filePath, source, 'utf8')
  return source
}

async function requestJson<T>(
  env: Env,
  auth: AuthFile,
  apiPath: string,
  options: { body?: unknown; method: 'GET' | 'POST' },
  tree: TreeFile,
): Promise<{ body: T; setCookie: string | null }> {
  const url = `https://${env.accountKey}${apiPath.startsWith('/') ? apiPath : '/' + apiPath}`
  const headers: Record<string, string> = {
    cookie: `apiToken=${auth.apiToken}`,
  }
  if (tree.backendSessionId) {
    headers['x-chatium-unique-id'] = tree.backendSessionId
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Chatium API ${apiPath} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  let body: T
  try {
    body = JSON.parse(text) as T
  } catch {
    throw new Error(`Chatium API ${apiPath} returned non-JSON response: ${text.slice(0, 500)}`)
  }

  return { body, setCookie: response.headers.get('set-cookie') }
}

function parseSessionId(setCookie: string | null): string | undefined {
  if (!setCookie) {
    return undefined
  }
  const match = setCookie.match(/(?:^|,\s*)x-chatium-unique-id=([^;,]+)/)
  return match ? decodeURIComponent(match[1]) : undefined
}

function ensureGitRepo(syncRoot: string) {
  if (!existsSync(path.join(syncRoot, '.git'))) {
    run('git', ['init'], syncRoot)
  }
}

function ensureGitExcludeIfRepo(syncRoot: string) {
  const gitDir = path.join(syncRoot, '.git')
  if (!existsSync(gitDir)) {
    return
  }
  const infoDir = path.join(gitDir, 'info')
  mkdirSync(infoDir, { recursive: true })
  const excludePath = path.join(infoDir, 'exclude')
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const entries = ['.chatium/', '.vscode/', 'node_modules/', '.DS_Store', 'tsconfig.json', '.gitignore', 'package.json']
  const missing = entries.filter(entry => !existing.split(/\r?\n/).includes(entry))
  if (missing.length > 0) {
    writeFileSync(excludePath, existing + (existing.endsWith('\n') || existing.length === 0 ? '' : '\n') + missing.join('\n') + '\n')
  }
}

function createAndStoreBaseline(env: Env): string {
  commitBaseline(env)

  const baselineCommit = git(env.syncRoot, ['rev-parse', 'HEAD']).stdout.trim()
  const state: StateFile = {
    accountKey: env.accountKey,
    baselineCommit,
    createdAt: new Date().toISOString(),
  }
  writeJson(env.statePath, state)
  chmodSync(env.statePath, 0o600)
  return baselineCommit
}

function commitBaseline(env: Env) {
  git(env.syncRoot, ['add', '-A', '--', '.'])
  const staged = git(env.syncRoot, ['diff', '--cached', '--quiet'], { allowFailure: true })
  const commitArgs =
    staged.status === 0
      ? ['commit', '--allow-empty', '-m', baselineMessage]
      : ['commit', '-m', baselineMessage]
  git(env.syncRoot, ['-c', 'user.name=Codex', '-c', 'user.email=codex@local', ...commitArgs])
}

function stashLocalChanges(env: Env): FinishStash | null {
  const before = revParseStash(env)
  const result = git(env.syncRoot, ['stash', 'push', '--include-untracked', '-m', finishStashMessage, '--', '.'], {
    allowFailure: true,
  })

  if (result.status !== 0) {
    throw new Error(`git stash push failed:\n${result.stderr || result.stdout}`)
  }

  const after = revParseStash(env)
  if (!after || after === before) {
    return null
  }

  return { commit: after, ref: 'stash@{0}' }
}

function applyFinishStash(env: Env, stash: FinishStash) {
  const result = git(env.syncRoot, ['stash', 'apply', stash.ref], { allowFailure: true })
  if (result.status === 0) {
    return
  }

  const conflicts = getConflictedPaths(env)
  const conflictDetails =
    conflicts.length > 0
      ? `Conflicted files:\n${conflicts.map(item => `- ${item}`).join('\n')}`
      : `Git status:\n${getShortGitStatus(env) || '(no conflicted paths reported by git)'}`
  const gitOutput = (result.stderr || result.stdout).trim()
  const outputDetails = gitOutput ? `\n\nGit output:\n${gitOutput}` : ''

  throw new Error(
    `Cannot reapply stashed local changes over latest server version.\n${conflictDetails}\nStash kept as ${stash.ref} (${stash.commit}). Do not upload local changes. Ask the user how to resolve this conflict before editing or retrying finish.${outputDetails}`,
  )
}

function dropFinishStash(env: Env, stash: FinishStash) {
  const top = revParseStash(env)
  if (!top) {
    return
  }
  if (top !== stash.commit) {
    throw new Error(`Refusing to drop ${stash.ref}: it no longer points to expected stash commit ${stash.commit}.`)
  }
  git(env.syncRoot, ['stash', 'drop', stash.ref])
}

function withPreservedStashMessage(error: unknown, stash: FinishStash | null): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (!stash || message.includes('Stash kept as')) {
    return error instanceof Error ? error : new Error(message)
  }
  return new Error(`${message}\nLocal changes are preserved in ${stash.ref} (${stash.commit}). Fix the problem, then run finish again.`)
}

function revParseStash(env: Env): string | null {
  const result = git(env.syncRoot, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFailure: true })
  if (result.status !== 0) {
    return null
  }
  return result.stdout.trim() || null
}

function getConflictedPaths(env: Env): string[] {
  const result = git(env.syncRoot, ['diff', '--name-only', '--diff-filter=U', '--'], { allowFailure: true })
  return result.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean)
}

function getShortGitStatus(env: Env): string {
  return git(env.syncRoot, ['status', '--short'], { allowFailure: true }).stdout.trim()
}

function getChangesSinceBaseline(env: Env, baselineCommit: string): Change[] {
  const diff = git(env.syncRoot, ['diff', '--name-status', '-M', baselineCommit, '--']).stdout
  const changes: Change[] = []

  for (const line of diff.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split('\t')
    const code = parts[0]
    if (code.startsWith('R')) {
      const oldPath = normalizePath(parts[1] ?? '')
      const newPath = normalizePath(parts[2] ?? '')
      if (oldPath && newPath && !isSystemPath(oldPath) && !isSystemPath(newPath)) {
        changes.push({ status: 'R', oldPath, path: newPath })
      }
    } else {
      const itemPath = normalizePath(parts[1] ?? '')
      if (!itemPath || isSystemPath(itemPath)) {
        continue
      }
      if (code === 'A' || code === 'M' || code === 'D') {
        changes.push({ status: code, path: itemPath })
      } else {
        changes.push({ status: existsSync(path.join(env.syncRoot, itemPath)) ? 'M' : 'D', path: itemPath })
      }
    }
  }

  const untracked = git(env.syncRoot, ['ls-files', '--others', '--exclude-standard']).stdout
  for (const itemPath of untracked.split(/\r?\n/).map(normalizePath).filter(Boolean)) {
    if (!isSystemPath(itemPath) && existsSync(path.join(env.syncRoot, itemPath)) && !changes.some(item => 'path' in item && item.path === itemPath)) {
      changes.push({ status: 'A', path: itemPath })
    }
  }

  return changes
}

function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}) {
  return run('git', args, cwd, options)
}

function run(command: string, args: string[], cwd: string, options: { allowFailure?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  })
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function saveNoIndexPatch(basePath: string, oursPath: string, patchPath: string) {
  const result = spawnSync('git', ['diff', '--no-index', '--', basePath, oursPath], { encoding: 'utf8' })
  writeFileSync(patchPath, result.stdout || result.stderr || '')
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return await new Promise(resolve => {
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => {
        input += chunk
      })
      process.stdin.on('end', () => resolve(input))
    })
  }

  return await new Promise((resolve, reject) => {
    const stdin = process.stdin
    const onData = (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      for (const char of text) {
        if (char === '\u0003') {
          cleanup()
          reject(new Error('Cancelled'))
          return
        }
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n')
          cleanup()
          resolve(input)
          return
        }
        if (char === '\u007f') {
          input = input.slice(0, -1)
        } else {
          input += char
        }
      }
    }
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    let input = ''
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

function parseProvidedToken(input: string): { accountKey?: string; apiToken: string } {
  if (input.startsWith('{')) {
    const data = JSON.parse(input)
    return { accountKey: data.accountKey, apiToken: data.apiToken || data.token || '' }
  }
  if (input.startsWith('vscode://')) {
    const url = new URL(input)
    return {
      accountKey: url.searchParams.get('accountPath') || undefined,
      apiToken: url.searchParams.get('token') || '',
    }
  }
  return { apiToken: input }
}

function isSystemPath(itemPath: string): boolean {
  const normalized = normalizePath(itemPath)
  const prefixes = ['.chatium', '.vscode', '.git', 'node_modules']
  if (['tsconfig.json', '.gitignore', 'package.json'].includes(normalized)) {
    return true
  }
  if (normalized.endsWith('.DS_Store')) {
    return true
  }
  return prefixes.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'))
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function sha1File(filePath: string): string {
  return createHash('sha1').update(readFileSync(filePath)).digest('hex')
}

function looksUtf8(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false
  }
  return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
}
