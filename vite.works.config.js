import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 勤怠アプリ eWorks のビルド（docs/eworks-plan.md 5-1）。
// 入口は works/index.html、出力は dist-works（wrangler.works.jsonc の assets）。
// 画面のコードは src/works/、共通部品（src/styles/ui.css など）はタスク管理と共有する。
export default defineConfig({
  root: resolve(import.meta.dirname, 'works'),
  publicDir: resolve(import.meta.dirname, 'works/public'),
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:8788' },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-works'),
    emptyOutDir: true,
  },
})
