/** TLS helpers shared by the database drivers. */

import fs from 'node:fs'
import type { ConnectionConfig } from '@shared/types'

/** The contents of the connection's CA file, or undefined to use the system trust store. */
export function readCaFile(config: ConnectionConfig): string | undefined {
  const file = config.sslCaFile?.trim()
  if (!file) return undefined
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`CA certificate file "${file}": ${(err as Error).message}`)
  }
}

const UNTRUSTED_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_UNTRUSTED'
])

/**
 * A certificate Node does not trust surfaces as a bare OpenSSL code; say what
 * to do about it. Managed services (RDS above all) sign with their own CA.
 */
export function explainTlsError(err: any, config: ConnectionConfig): any {
  if (!err || !UNTRUSTED_CODES.has(err.code)) return err
  const hint = config.sslCaFile?.trim()
    ? `The server's certificate was not signed by any CA in "${config.sslCaFile}". Check it is the right bundle for this server.`
    : 'The server presented a certificate from a CA this machine does not trust. Set "CA Certificate" ' +
      "in the connection settings to the provider's CA bundle (for AWS RDS, Amazon's global-bundle.pem), " +
      'or untick "Verify server certificate".'
  err.message = `${err.message}\n\n${hint}`
  if (typeof err.sqlMessage === 'string') err.sqlMessage = err.message
  return err
}
