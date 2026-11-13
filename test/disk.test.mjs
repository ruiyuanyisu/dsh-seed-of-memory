import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diskStatus, storageLine, DEFAULT_MIN_FREE_MB } from '../lib/disk.js'

const GB = 1024 * 1024 * 1024

function fakeStatfs({ freeBytes, totalBytes = 200 * GB, bsize = 4096 }) {
  return () => ({
    bsize,
    blocks: Math.round(totalBytes / bsize),
    bfree: Math.round(freeBytes / bsize),
    bavail: Math.round(freeBytes / bsize),
  })
}

test('diskStatus reports free space and is not low when roomy', () => {
  const status = diskStatus('C:/fake', { statfsFn: fakeStatfs({ freeBytes: 50 * GB }) })
  assert.equal(status.low, false)
  assert.equal(status.minFreeMB, DEFAULT_MIN_FREE_MB)
  assert.ok(status.freeMB > 40 * 1024)
  assert.equal(storageLine(status), '')
})

test('diskStatus flags low space against a custom threshold', () => {
  const status = diskStatus('C:/fake', {
    statfsFn: fakeStatfs({ freeBytes: 120 * 1024 * 1024 }),
    minFreeMB: 300,
  })
  assert.equal(status.low, true)
  assert.equal(status.freeMB, 120)
  assert.match(storageLine(status), /\[存储\].*只剩 120 MB（低于 300 MB 阈值）/)
  assert.match(storageLine(status), /C:\/fake/)
})

test('diskStatus clamps silly thresholds and never goes below 1 MB', () => {
  const status = diskStatus('C:/fake', {
    statfsFn: fakeStatfs({ freeBytes: 10 * 1024 * 1024 }),
    minFreeMB: 0,
  })
  assert.equal(status.minFreeMB, 1)
  assert.equal(status.low, false)
})

test('diskStatus returns null when statfs throws or returns nothing', () => {
  const boom = () => {
    throw new Error('nope')
  }
  assert.equal(diskStatus('C:/fake', { statfsFn: boom }), null)
  assert.equal(diskStatus('C:/fake', { statfsFn: () => null }), null)
})
