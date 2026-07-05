/**
 * Minimal ZIP extractor (phase 09) unit tests. Archives are Buffer-crafted
 * in-memory — we control the format bytes, so CRC fields stay ZERO throughout
 * (the extractor deliberately skips CRC32: the real Deno archives are sha256-
 * pinned before extraction) and that skipping is itself pinned here.
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractZipEntry } from '../../src/main/security/zip'

interface FixtureEntry {
  name: string
  data: Buffer
  method: 0 | 8
}

/** Byte offsets (relative) used by the tests to patch crafted archives. */
const EOCD_BYTES = 22
const EOCD_ENTRIES_ON_DISK = 8
const EOCD_TOTAL_ENTRIES = 10
const EOCD_CD_OFFSET = 16
const CENTRAL_COMPRESSED_SIZE = 20

/** Craft a spec-shaped zip: local headers + central directory + EOCD. */
function buildZip(entries: FixtureEntry[], options?: { comment?: Buffer }): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const payload = entry.method === 8 ? deflateRawSync(entry.data) : entry.data

    const local = Buffer.alloc(30) // crc/time/date/flags left zero on purpose
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(payload.length, CENTRAL_COMPRESSED_SIZE)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += 30 + nameBytes.length + payload.length
  }
  const centralBuffer = Buffer.concat(centralParts)
  const comment = options?.comment ?? Buffer.alloc(0)
  const eocd = Buffer.alloc(EOCD_BYTES)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, EOCD_ENTRIES_ON_DISK)
  eocd.writeUInt16LE(entries.length, EOCD_TOTAL_ENTRIES)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, EOCD_CD_OFFSET)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...localParts, centralBuffer, eocd, comment])
}

/** Binary payload exercising all byte values (round-trip fidelity). */
const binaryPayload = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256))
/** Compressible payload so deflate actually shrinks it. */
const textPayload = Buffer.from('the deno binary placeholder line\n'.repeat(64), 'utf8')

describe('extractZipEntry', () => {
  it('extracts a stored (method 0) entry byte-identically', () => {
    const zip = buildZip([{ name: 'deno.exe', data: binaryPayload, method: 0 }])
    const entry = extractZipEntry(zip, (name) => name === 'deno.exe')
    expect(entry.name).toBe('deno.exe')
    expect(entry.data.equals(binaryPayload)).toBe(true)
  })

  it('extracts a deflated (method 8) entry byte-identically', () => {
    const zip = buildZip([{ name: 'deno', data: textPayload, method: 8 }])
    // Sanity: the archive really is smaller than the payload (deflate happened).
    expect(zip.length).toBeLessThan(textPayload.length)
    const entry = extractZipEntry(zip, (name) => name === 'deno')
    expect(entry.data.equals(textPayload)).toBe(true)
  })

  it('selects among multiple entries by predicate (first match, CD order)', () => {
    const readme = Buffer.from('read me first', 'utf8')
    const zip = buildZip([
      { name: 'README.md', data: readme, method: 0 },
      { name: 'bin/deno.exe', data: binaryPayload, method: 8 },
      { name: 'LICENSE', data: Buffer.from('MIT', 'utf8'), method: 0 }
    ])
    const entry = extractZipEntry(zip, (name) => name.endsWith('/deno.exe') || name === 'deno.exe')
    expect(entry.name).toBe('bin/deno.exe')
    expect(entry.data.equals(binaryPayload)).toBe(true)
    // A broader predicate returns the FIRST matching entry.
    expect(extractZipEntry(zip, () => true).name).toBe('README.md')
  })

  it('finds the EOCD behind a trailing archive comment', () => {
    const zip = buildZip([{ name: 'deno', data: textPayload, method: 8 }], {
      comment: Buffer.from('release notes trailer padding'.repeat(10), 'utf8')
    })
    expect(extractZipEntry(zip, () => true).data.equals(textPayload)).toBe(true)
  })

  it('throws clearly when no entry matches', () => {
    const zip = buildZip([{ name: 'README.md', data: textPayload, method: 0 }])
    expect(() => extractZipEntry(zip, (name) => name === 'deno.exe')).toThrow(/no zip entry matched/)
  })

  it('throws on a malformed EOCD (corrupted signature)', () => {
    const zip = buildZip([{ name: 'deno', data: binaryPayload, method: 0 }])
    zip.writeUInt32LE(0x06054b51, zip.length - EOCD_BYTES) // last byte of the sig flipped
    expect(() => extractZipEntry(zip, () => true)).toThrow(/End-of-Central-Directory/)
  })

  it('throws on garbage and on truncated buffers', () => {
    expect(() => extractZipEntry(Buffer.alloc(100), () => true)).toThrow(/End-of-Central-Directory/)
    expect(() => extractZipEntry(Buffer.alloc(4), () => true)).toThrow(/shorter than/)
    const zip = buildZip([{ name: 'deno', data: binaryPayload, method: 0 }])
    expect(() => extractZipEntry(Buffer.from(zip.subarray(0, zip.length - 4)), () => true)).toThrow(
      /End-of-Central-Directory/
    )
  })

  it('throws on zip64 markers in the EOCD (0xFFFF entry count)', () => {
    const zip = buildZip([{ name: 'deno', data: binaryPayload, method: 0 }])
    zip.writeUInt16LE(0xffff, zip.length - EOCD_BYTES + EOCD_ENTRIES_ON_DISK)
    zip.writeUInt16LE(0xffff, zip.length - EOCD_BYTES + EOCD_TOTAL_ENTRIES)
    expect(() => extractZipEntry(zip, () => true)).toThrow(/zip64/)
  })

  it('throws on zip64 markers in a matched central entry (0xFFFFFFFF size)', () => {
    const zip = buildZip([{ name: 'deno', data: binaryPayload, method: 0 }])
    const centralOffset = zip.readUInt32LE(zip.length - EOCD_BYTES + EOCD_CD_OFFSET)
    zip.writeUInt32LE(0xffffffff, centralOffset + CENTRAL_COMPRESSED_SIZE)
    expect(() => extractZipEntry(zip, () => true)).toThrow(/zip64/)
  })

  it('throws on unsupported compression methods', () => {
    const zip = buildZip([{ name: 'deno', data: binaryPayload, method: 0 }])
    const centralOffset = zip.readUInt32LE(zip.length - EOCD_BYTES + EOCD_CD_OFFSET)
    zip.writeUInt16LE(12, centralOffset + 10) // method 12 = bzip2 — not ours
    zip.writeUInt16LE(12, 8) // keep the local header consistent
    expect(() => extractZipEntry(zip, () => true)).toThrow(/unsupported compression method 12/)
  })
})
