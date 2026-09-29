/**
 * The contract between the Electron main process and the renderer.
 *
 * Both sides import from here, so a channel rename or a payload change is a
 * type error rather than a runtime surprise. Nothing in this package may
 * import `electron` — it is bundled into the renderer as well.
 */

export const IpcChannel = {
  GetAppInfo: 'app:get-info',
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppInfo {
  name: string
  version: string
  /** `process.platform`, e.g. `darwin`, `win32`, `linux`. */
  platform: string
  arch: string
  isPackaged: boolean
  versions: {
    electron: string
    chrome: string
    node: string
    v8: string
  }
}

/**
 * Where renderer-initiated navigation is allowed to end up.
 *
 * Handing an arbitrary URL to the OS is how a renderer reaches things a
 * browser never would: `file://`, `smb://`, and every scheme some other
 * installed app has registered. Only the two web schemes leave the app, and
 * the parsed href is what gets handed on, never the raw string.
 */
export function externalUrl(url: string): string | null {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  return parsed.href
}

/** The surface `preload` exposes on `window.adamant`. */
export interface AdamantApi {
  getAppInfo(): Promise<AppInfo>
}

declare global {
  interface Window {
    adamant: AdamantApi
  }
}
