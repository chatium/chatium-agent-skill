import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { classifyUploadChanges, getChangesSinceBaseline, type Change, type Entity, type TreeFile } from './chatium-sync.ts'

test('skips modified files that already match the synced checksum', () => {
  withFixture(syncRoot => {
    const checksum = writeSource(syncRoot, 'app.ts', 'server')
    const change: Change = { status: 'M', path: 'app.ts' }
    const tree = treeWith(entity('app.ts', checksum))
    const plan = classifyUploadChanges({ syncRoot }, [change], tree, { 'app.ts': entity('app.ts', checksum) })

    assert.deepEqual(plan.fileUploads, [])
    assert.deepEqual(plan.skippedAlreadySynced, [change])
    assert.deepEqual(plan.conflicts, [])
  })
})

test('uploads genuinely modified files', () => {
  withFixture(syncRoot => {
    const syncedChecksum = checksumFor('server')
    writeSource(syncRoot, 'app.ts', 'local')
    const change: Change = { status: 'M', path: 'app.ts' }
    const tree = treeWith(entity('app.ts', syncedChecksum))
    const plan = classifyUploadChanges({ syncRoot }, [change], tree, { 'app.ts': entity('app.ts', syncedChecksum) })

    assert.deepEqual(plan.fileUploads, [change])
    assert.deepEqual(plan.skippedAlreadySynced, [])
    assert.deepEqual(plan.conflicts, [])
  })
})

test('skips added files that already exist on Chatium with the synced checksum', () => {
  withFixture(syncRoot => {
    const checksum = writeSource(syncRoot, 'new.ts', 'server')
    const change: Change = { status: 'A', path: 'new.ts' }
    const tree = treeWith(entity('new.ts', checksum))
    const plan = classifyUploadChanges({ syncRoot }, [change], tree, { 'new.ts': entity('new.ts', checksum) })

    assert.deepEqual(plan.fileUploads, [])
    assert.deepEqual(plan.skippedAlreadySynced, [change])
    assert.deepEqual(plan.conflicts, [])
  })
})

test('skips deletions that are already absent locally, in tree state, and on Chatium', () => {
  withFixture(syncRoot => {
    const change: Change = { status: 'D', path: 'old.ts' }
    const plan = classifyUploadChanges({ syncRoot }, [change], treeWith(), {})

    assert.deepEqual(plan.deleteUploads, [])
    assert.deepEqual(plan.skippedAlreadySynced, [change])
    assert.deepEqual(plan.conflicts, [])
  })
})

test('reports stale remote conflicts for files that otherwise look already synced', () => {
  withFixture(syncRoot => {
    const syncedChecksum = writeSource(syncRoot, 'app.ts', 'server')
    const remoteChecksum = checksumFor('new server')
    const change: Change = { status: 'M', path: 'app.ts' }
    const tree = treeWith(entity('app.ts', syncedChecksum))
    const plan = classifyUploadChanges({ syncRoot }, [change], tree, { 'app.ts': entity('app.ts', remoteChecksum) })

    assert.deepEqual(plan.fileUploads, [])
    assert.deepEqual(plan.skippedAlreadySynced, [])
    assert.equal(plan.conflicts.length, 1)
    assert.match(plan.conflicts[0], /server checksum changed/)
  })
})

test('skips renames that are already reflected on Chatium', () => {
  withFixture(syncRoot => {
    const checksum = writeSource(syncRoot, 'new.ts', 'server')
    const change: Change = { status: 'R', oldPath: 'old.ts', path: 'new.ts' }
    const tree = treeWith(entity('new.ts', checksum))
    const plan = classifyUploadChanges({ syncRoot }, [change], tree, { 'new.ts': entity('new.ts', checksum) })

    assert.deepEqual(plan.renameUploads, [])
    assert.deepEqual(plan.fileUploads, [])
    assert.deepEqual(plan.skippedAlreadySynced, [change])
    assert.deepEqual(plan.conflicts, [])
  })
})

test('detects committed local changes since the stored baseline', () => {
  withFixture(syncRoot => {
    git(syncRoot, ['init'])
    writeSource(syncRoot, 'app.ts', 'server')
    git(syncRoot, ['add', 'app.ts'])
    git(syncRoot, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline'])
    const baselineCommit = git(syncRoot, ['rev-parse', 'HEAD']).stdout.trim()

    writeSource(syncRoot, 'app.ts', 'committed local change')
    git(syncRoot, ['add', 'app.ts'])
    git(syncRoot, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'local change'])

    const changes = getChangesSinceBaseline({ syncRoot }, baselineCommit)
    assert.deepEqual(changes, [{ status: 'M', path: 'app.ts' }])
  })
})

function withFixture(run: (syncRoot: string) => void) {
  const syncRoot = mkdtempSync(path.join(tmpdir(), 'chatium-sync-test-'))
  try {
    run(syncRoot)
  } finally {
    rmSync(syncRoot, { force: true, recursive: true })
  }
}

function writeSource(syncRoot: string, itemPath: string, content: string): string {
  const filePath = path.join(syncRoot, itemPath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return checksumFor(content)
}

function checksumFor(content: string): string {
  return createHash('sha1').update(Buffer.from(content, 'utf8')).digest('hex')
}

function treeWith(...entities: Entity[]): TreeFile {
  return {
    items: Object.fromEntries(entities.map(item => [item.path, { ...item, state: 'synced', syncedChecksum: item.checksum }])),
  }
}

function entity(itemPath: string, checksum: string): Entity {
  return {
    id: itemPath,
    slug: path.basename(itemPath),
    path: itemPath,
    checksum,
    parentId: null,
    entityType: 'file',
    isDirectory: false,
  }
}

function git(cwd: string, args: string[]): { stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
  }
  return { stdout: result.stdout || '' }
}
