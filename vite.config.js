import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // ビルド時刻をバンドルに埋め込む（画面の「ver.…」表示用。src/lib/version.js で参照）
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
})
