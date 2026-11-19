import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import '../styles/ui.css'
import './works.css'
import App from './App.jsx'
import { installHalfWidthInput } from '../lib/halfWidthInput'

installHalfWidthInput()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// Service Worker の登録と更新の検知は App.jsx の ReloadPrompt が行う
