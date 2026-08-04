/** SSH tunnelling for `Standard TCP/IP over SSH` connections. */

import net from 'node:net'
import fs from 'node:fs'
import { Client, type ConnectConfig } from 'ssh2'
import type { ConnectionConfig } from '@shared/types'
import { toSupportedPrivateKey } from './ppk'

export interface Tunnel {
  localPort: number
  close(): void
}

/**
 * Opens an SSH connection and a local TCP listener that forwards every
 * incoming socket to `remoteHost:remotePort` through it.
 */
export function openTunnel(config: ConnectionConfig, timeoutMs: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const ssh = new Client()
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      try {
        ssh.end()
      } catch {
        /* already down */
      }
      reject(err)
    }

    const opts: ConnectConfig = {
      host: config.sshHost || '127.0.0.1',
      port: config.sshPort || 22,
      username: config.sshUser || '',
      readyTimeout: timeoutMs,
      keepaliveInterval: 20000
    }

    if (config.sshKeyFile) {
      try {
        opts.privateKey = toSupportedPrivateKey(fs.readFileSync(config.sshKeyFile))
      } catch (err) {
        reject(new Error(`SSH key file "${config.sshKeyFile}": ${(err as Error).message}`))
        return
      }
      if (config.sshPassphrase) opts.passphrase = config.sshPassphrase
    }
    if (config.sshPassword) opts.password = config.sshPassword

    ssh.on('error', (err) => fail(new Error(`SSH: ${err.message}`)))

    ssh.on('ready', () => {
      const server = net.createServer((socket) => {
        ssh.forwardOut(
          '127.0.0.1',
          0,
          config.host || '127.0.0.1',
          config.port || 3306,
          (err, stream) => {
            if (err) {
              socket.destroy()
              return
            }
            socket.pipe(stream).pipe(socket)
            stream.on('error', () => socket.destroy())
            socket.on('error', () => stream.end())
          }
        )
      })

      server.on('error', (err) => fail(new Error(`SSH tunnel listener: ${err.message}`)))

      // Port 0 lets the OS pick a free local port.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          fail(new Error('SSH tunnel could not bind a local port'))
          return
        }
        settled = true
        resolve({
          localPort: address.port,
          close: () => {
            try {
              server.close()
            } catch {
              /* ignore */
            }
            try {
              ssh.end()
            } catch {
              /* ignore */
            }
          }
        })
      })
    })

    ssh.connect(opts)
  })
}
