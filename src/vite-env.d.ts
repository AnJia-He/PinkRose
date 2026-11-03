/// <reference types="vite/client" />

type PinkRoseDesktopStorageInfo = {
  dataDir: string
  platform: string
  version: string
}

interface Window {
  pinkroseDesktop?: {
    isDesktop: true
    platform: string
    getStorageInfo(): Promise<PinkRoseDesktopStorageInfo>
    openStorageFolder(): Promise<{ ok: true }>
    chooseStorageFolder(): Promise<{ ok: true }>
  }
}
