import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/ui.css'
import App from './App.jsx'
import { installHalfWidthInput } from './lib/halfWidthInput'

// 数値・時刻の入力欄で全角を半角に直す（アプリ全体。2026-11-02）
installHalfWidthInput()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
