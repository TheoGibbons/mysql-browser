const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { build } = require('../package.json')

// Only release builds load this config. Local dist/dist:installer builds can
// still run without Azure credentials.
module.exports = () => {
  const publisherName = 'Theo Gibbons'

  return {
    ...build,
    forceCodeSigning: true,
    win: {
      ...build.win,
      signtoolOptions: {
        // Embeds the expected publisher in app-update.yml for electron-updater.
        publisherName,
        signingHashAlgorithms: ['sha256'],
        sign: async ({ path: filePath }) => {
          if (process.platform !== 'win32') {
            throw new Error('Azure release signing must run on Windows.')
          }
          // Serialize calls: the Microsoft module installs shared dependencies
          // and writes shared signing metadata. Pass paths as arguments, never
          // interpolate them into PowerShell source (the app name has spaces).
          execFileSync('pwsh.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive',
            '-File', path.join(__dirname, 'sign-windows.ps1'),
            '-FilePath', filePath,
            '-PublisherName', publisherName
          ], { stdio: 'inherit' })
        }
      }
    }
  }
}
