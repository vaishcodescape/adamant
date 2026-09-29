import { app, BrowserWindow, shell } from 'electron'
import { externalUrl } from '@adamant/shared'
import { registerIpcHandlers } from './ipc'
import { createMainWindow } from './window'

// A second launch should focus the running window instead of starting a rival
// instance that fights over the same workspace state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  hardenWebContents()

  app.whenReady().then(() => {
    registerIpcHandlers()
    createMainWindow()

    // macOS keeps the process alive after the last window closes.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

function openInBrowser(url: string): void {
  const href = externalUrl(url)
  if (href) void shell.openExternal(href)
}

/**
 * Renderer content must never be able to navigate the app frame elsewhere or
 * spawn unaudited windows; external links go to the user's real browser.
 */
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) {
        event.preventDefault()
        openInBrowser(url)
      }
    })

    contents.setWindowOpenHandler(({ url }) => {
      openInBrowser(url)
      return { action: 'deny' }
    })
  })
}
