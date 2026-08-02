/**
 * Shown when the page is opened in a plain web browser instead of the Electron
 * shell. Without the preload bridge (`window.api`) the app can't reach MySQL,
 * so rather than hang on "Loading…" we explain how to run it.
 */
export function BrowserNotice(): JSX.Element {
  return (
    <div className="browser-notice">
      <div className="browser-notice-card">
        <div className="browser-notice-icon">🖥️</div>
        <h1>Open me in the desktop app</h1>
        <p>
          You’re viewing <strong>MySQL Browser</strong> in a web browser. It needs its desktop
          shell to run — a browser tab can’t open MySQL or SSH connections, so this page has nothing
          to talk to.
        </p>
        <p className="browser-notice-how">
          Launch the installed <strong>MySQL Browser</strong> app, or start it in development with:
        </p>
        <pre className="browser-notice-cmd">npm run dev</pre>
        <p className="browser-notice-foot">You can close this browser tab.</p>
      </div>
    </div>
  )
}
