import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { appVersion } from './scripts/app-version.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // このアプリの画面を最後に変えたコミットの時刻を埋め込む（scripts/app-version.mjs。版が同じなら同じ中身になる）。もとはビルド時刻（画面の「ver.…」表示用。src/lib/version.js で参照）
  define: {
    __BUILD_TIME__: JSON.stringify(appVersion('tasks').time),
  },
})
