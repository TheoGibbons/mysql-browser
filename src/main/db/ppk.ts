/**
 * PuTTY private key (.ppk) support.
 *
 * ssh2 parses PPK version 2 itself but not version 3, which PuTTY has written
 * by default since 0.75. This repacks a v3 file as an unencrypted OpenSSH
 * private key, which ssh2 does understand.
 */

import crypto from 'node:crypto'

interface Ppk {
  version: number
  encryption: string
  comment: string
  publicBlob: Buffer
  privateBlob: Buffer
}

/**
 * Returns a private key in a format ssh2 can parse. OpenSSH/PEM keys and PPK
 * v2 are passed through untouched; PPK v3 is converted.
 */
export function toSupportedPrivateKey(raw: Buffer): Buffer | string {
  const ppk = parsePpk(raw)
  if (!ppk || ppk.version <= 2) return raw

  if (ppk.encryption !== 'none') {
    throw new Error(
      'this is a passphrase-protected PuTTY v3 key, which uses Argon2 key derivation that is not supported yet. ' +
        'Open it in PuTTYgen and either save it without a passphrase, or use Conversions > Export OpenSSH key.'
    )
  }

  return toOpenSshPem(ppk)
}

function parsePpk(raw: Buffer): Ppk | null {
  // A binary OpenSSH key would produce garbage here, so bail before doing work.
  const text = raw.toString('utf8')
  const header = /^PuTTY-User-Key-File-(\d+): *[^\r\n]+/.exec(text)
  if (!header) return null

  const lines = text.split(/\r?\n/)
  const fields = new Map<string, string>()
  let publicBlob = Buffer.alloc(0)
  let privateBlob = Buffer.alloc(0)

  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9-]+): ?(.*)$/.exec(lines[i])
    if (!match) continue
    const [, name, value] = match

    // `X-Lines: n` is a count followed by n lines of base64 payload.
    if (name === 'Public-Lines' || name === 'Private-Lines') {
      const count = Number(value)
      if (!Number.isInteger(count) || count < 0) throw new Error(`malformed ${name} header`)
      const blob = Buffer.from(lines.slice(i + 1, i + 1 + count).join(''), 'base64')
      if (name === 'Public-Lines') publicBlob = blob
      else privateBlob = blob
      i += count
    } else {
      fields.set(name, value.trim())
    }
  }

  return {
    version: Number(header[1]),
    encryption: fields.get('Encryption') || 'none',
    comment: fields.get('Comment') || '',
    publicBlob,
    privateBlob
  }
}

function toOpenSshPem(ppk: Ppk): string {
  const pub = new BlobReader(ppk.publicBlob)
  const priv = new BlobReader(ppk.privateBlob)
  const algorithm = pub.text()

  let fields: Buffer
  if (algorithm === 'ssh-rsa') fields = rsaFields(pub, priv)
  else if (algorithm === 'ssh-ed25519') fields = ed25519Fields(pub, priv)
  else if (algorithm.startsWith('ecdsa-sha2-')) fields = ecdsaFields(algorithm, pub, priv)
  else throw new Error(`v3 keys of type "${algorithm}" are not supported. Export the key as OpenSSH from PuTTYgen.`)

  return wrapOpenSsh(ppk.publicBlob, fields, ppk.comment)
}

/** OpenSSH orders the RSA fields n, e, d, iqmp, p, q. */
function rsaFields(pub: BlobReader, priv: BlobReader): Buffer {
  const e = pub.string()
  const n = pub.string()
  const d = priv.string()
  const p = priv.string()
  const q = priv.string()

  // PuTTY's stored iqmp is deliberately ignored: it has used the opposite p/q
  // ordering to OpenSSL in the past, so recompute it for the p and q we emit.
  const iqmp = mpint(modInverse(toBigInt(q), toBigInt(p)))

  return Buffer.concat([str('ssh-rsa'), str(n), str(e), str(d), str(iqmp), str(p), str(q)])
}

function ed25519Fields(pub: BlobReader, priv: BlobReader): Buffer {
  const point = pub.string()
  if (point.length !== 32) throw new Error('malformed Ed25519 public key')
  // PuTTY reads the 32-byte seed little-endian into a bignum, so reverse it back.
  const seed = fixedWidth(priv.string(), 32).reverse()
  return Buffer.concat([str('ssh-ed25519'), str(point), str(Buffer.concat([seed, point]))])
}

function ecdsaFields(algorithm: string, pub: BlobReader, priv: BlobReader): Buffer {
  const curve = pub.string()
  const point = pub.string()
  const d = priv.string()
  return Buffer.concat([str(algorithm), str(curve), str(point), str(d)])
}

/** Builds the unencrypted `openssh-key-v1` container around one key. */
function wrapOpenSsh(publicBlob: Buffer, privateFields: Buffer, comment: string): string {
  // Both check integers must match; on a real key they guard against a bad
  // passphrase, but the block is unencrypted here so any value works.
  const check = crypto.randomBytes(4)
  const body = Buffer.concat([check, check, privateFields, str(comment)])

  // Pad to the cipher block size with the bytes 1, 2, 3, ... even for `none`.
  const blockSize = 8
  const padding = Buffer.from(
    Array.from({ length: (blockSize - (body.length % blockSize)) % blockSize }, (_, i) => i + 1)
  )

  const key = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    str('none'), // cipher
    str('none'), // kdf
    str(''), // kdf options
    uint32(1), // key count
    str(publicBlob),
    str(Buffer.concat([body, padding]))
  ])

  const lines = key.toString('base64').match(/.{1,70}/g) ?? []
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', ...lines, '-----END OPENSSH PRIVATE KEY-----'].join('\n')
}

/** Walks the `uint32 length + payload` fields that make up an SSH blob. */
class BlobReader {
  private offset = 0

  constructor(private readonly buf: Buffer) {}

  string(): Buffer {
    if (this.offset + 4 > this.buf.length) throw new Error('key data is truncated')
    const length = this.buf.readUInt32BE(this.offset)
    const start = this.offset + 4
    if (start + length > this.buf.length) throw new Error('key data is truncated')
    this.offset = start + length
    return this.buf.subarray(start, this.offset)
  }

  text(): string {
    return this.string().toString('utf8')
  }
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value)
  return buf
}

function str(value: Buffer | string): Buffer {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  return Buffer.concat([uint32(payload.length), payload])
}

function toBigInt(buf: Buffer): bigint {
  return buf.length ? BigInt(`0x${buf.toString('hex')}`) : 0n
}

/** Encodes a bignum the way SSH does: big-endian, two's complement, minimal. */
function mpint(value: bigint): Buffer {
  if (value === 0n) return Buffer.alloc(0)
  const hex = value.toString(16)
  const buf = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')
  return buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf
}

/** Left-pads an mpint to the fixed width an algorithm expects. */
function fixedWidth(value: Buffer, size: number): Buffer {
  let start = 0
  while (start < value.length && value[start] === 0) start++
  const trimmed = value.subarray(start)
  if (trimmed.length > size) throw new Error('oversized value in key data')
  const out = Buffer.alloc(size)
  trimmed.copy(out, size - trimmed.length)
  return out
}

function modInverse(a: bigint, m: bigint): bigint {
  let [prevR, r] = [((a % m) + m) % m, m]
  let [prevS, s] = [1n, 0n]
  while (r !== 0n) {
    const quotient = prevR / r
    ;[prevR, r] = [r, prevR - quotient * r]
    ;[prevS, s] = [s, prevS - quotient * s]
  }
  if (prevR !== 1n) throw new Error('key contains inconsistent RSA parameters')
  return ((prevS % m) + m) % m
}
