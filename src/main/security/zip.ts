/**
 * Minimal ZIP reader for the managed Deno release archives (§11 default lane,
 * phase 09). Dependency-free on purpose: node:zlib inflateRawSync + Buffer
 * parsing cover everything a single-binary GitHub release zip actually uses —
 * compression methods 0 (stored) and 8 (deflate), one central directory, no
 * multi-disk spanning.
 *
 * CRC32 verification is intentionally SKIPPED: the outer archive is sha256-
 * pinned (config.ts DENO_PLATFORM_ASSETS) and verified against that pin
 * BEFORE extraction is ever attempted, which subsumes the per-entry CRC —
 * a corrupted download never reaches this module.
 *
 * No zip64 support: the Deno archives are ~42 MB, far below the 4 GiB /
 * 65535-entry thresholds. Encountering zip64 markers (0xFFFFFFFF sizes or
 * offsets, 0xFFFF entry counts) throws clearly instead of mis-reading the
 * 64-bit extension records.
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** Fixed portion of the End-of-Central-Directory record. */
const EOCD_MIN_BYTES = 22
/** Fixed portion of a local file header / central-directory entry. */
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
/** Max EOCD trailing-comment length — how far back from EOF the scan looks. */
const MAX_COMMENT_BYTES = 0xffff
/** zip64 "value lives in the extra field" markers. */
const ZIP64_U32 = 0xffffffff
const ZIP64_U16 = 0xffff

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  /** Entry name exactly as stored (forward-slash separated). */
  readonly name: string
  /** Fully decompressed entry bytes. */
  readonly data: Buffer
}

interface EndOfCentralDirectory {
  readonly entryCount: number
  readonly centralOffset: number
  readonly centralSize: number
}

/**
 * Return the FIRST central-directory entry whose name satisfies `predicate`,
 * fully decompressed. Throws ZipError when no entry matches or the archive
 * is malformed / uses features outside the supported subset.
 */
export function extractZipEntry(zipBuffer: Buffer, predicate: (name: string) => boolean): ZipEntry {
  const eocd = findEndOfCentralDirectory(zipBuffer)
  let at = eocd.centralOffset
  for (let i = 0; i < eocd.entryCount; i++) {
    if (at + CENTRAL_HEADER_BYTES > zipBuffer.length || zipBuffer.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new ZipError(`malformed zip: central-directory entry ${i} missing at offset ${at}`)
    }
    const method = zipBuffer.readUInt16LE(at + 10)
    const compressedSize = zipBuffer.readUInt32LE(at + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(at + 24)
    const nameLength = zipBuffer.readUInt16LE(at + 28)
    const extraLength = zipBuffer.readUInt16LE(at + 30)
    const commentLength = zipBuffer.readUInt16LE(at + 32)
    const localOffset = zipBuffer.readUInt32LE(at + 42)
    const nameEnd = at + CENTRAL_HEADER_BYTES + nameLength
    if (nameEnd > zipBuffer.length) {
      throw new ZipError(`malformed zip: central-directory entry ${i} name extends past the archive end`)
    }
    const name = zipBuffer.subarray(at + CENTRAL_HEADER_BYTES, nameEnd).toString('utf8')
    at = nameEnd + extraLength + commentLength
    if (!predicate(name)) continue
    if (compressedSize === ZIP64_U32 || uncompressedSize === ZIP64_U32 || localOffset === ZIP64_U32) {
      throw new ZipError(
        `zip64 archive not supported: entry '${name}' carries 0xFFFFFFFF size/offset markers ` +
          '(the pinned Deno archives are far below zip64 thresholds — refusing to guess)'
      )
    }
    return { name, data: readEntryData(zipBuffer, name, localOffset, method, compressedSize, uncompressedSize) }
  }
  throw new ZipError(`no zip entry matched the predicate (scanned ${eocd.entryCount} entries)`)
}

/**
 * Scan backwards from EOF for the EOCD signature (the record may be followed
 * by up to 65535 comment bytes). Scanning from the end finds the true record
 * even when entry payloads happen to contain the signature bytes.
 */
function findEndOfCentralDirectory(zip: Buffer): EndOfCentralDirectory {
  if (zip.length < EOCD_MIN_BYTES) {
    throw new ZipError('malformed zip: shorter than an End-of-Central-Directory record')
  }
  const scanFloor = Math.max(0, zip.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES)
  for (let at = zip.length - EOCD_MIN_BYTES; at >= scanFloor; at--) {
    if (zip.readUInt32LE(at) !== EOCD_SIG) continue
    const entriesOnDisk = zip.readUInt16LE(at + 8)
    const entryCount = zip.readUInt16LE(at + 10)
    const centralSize = zip.readUInt32LE(at + 12)
    const centralOffset = zip.readUInt32LE(at + 16)
    if (entryCount === ZIP64_U16 || centralOffset === ZIP64_U32 || centralSize === ZIP64_U32) {
      throw new ZipError('zip64 archive not supported: End-of-Central-Directory carries zip64 markers')
    }
    if (entriesOnDisk !== entryCount) {
      throw new ZipError('multi-disk zip archives are not supported')
    }
    if (centralOffset + centralSize > at) {
      throw new ZipError('malformed zip: central directory extends past its end record')
    }
    return { entryCount, centralOffset, centralSize }
  }
  throw new ZipError('malformed zip: End-of-Central-Directory record not found')
}

function readEntryData(
  zip: Buffer,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number
): Buffer {
  if (localOffset + LOCAL_HEADER_BYTES > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIG) {
    throw new ZipError(`malformed zip: local file header for '${name}' missing at offset ${localOffset}`)
  }
  // The LOCAL header's name/extra lengths can legitimately differ from the
  // central copies (extra fields are commonly rewritten), so the data offset
  // must be computed from the local header. SIZES however come from the
  // central directory: when general-purpose flag bit 3 (streaming data
  // descriptor) is set the local size fields are zero.
  const nameLength = zip.readUInt16LE(localOffset + 26)
  const extraLength = zip.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength
  const dataEnd = dataStart + compressedSize
  if (dataEnd > zip.length) {
    throw new ZipError(`malformed zip: entry '${name}' data extends past the archive end`)
  }
  const raw = zip.subarray(dataStart, dataEnd)
  if (method === 0) {
    if (compressedSize !== uncompressedSize) {
      throw new ZipError(`malformed zip: stored entry '${name}' has mismatched sizes (${compressedSize} vs ${uncompressedSize})`)
    }
    return Buffer.from(raw) // copy — the caller may outlive the archive buffer
  }
  if (method === 8) {
    let inflated: Buffer
    try {
      inflated = inflateRawSync(raw)
    } catch (err) {
      throw new ZipError(`malformed zip: entry '${name}' failed to inflate — ${err instanceof Error ? err.message : String(err)}`)
    }
    if (inflated.length !== uncompressedSize) {
      throw new ZipError(`malformed zip: entry '${name}' inflated to ${inflated.length} bytes, expected ${uncompressedSize}`)
    }
    return inflated
  }
  throw new ZipError(`unsupported compression method ${method} for entry '${name}' (only 0 = stored and 8 = deflate)`)
}
