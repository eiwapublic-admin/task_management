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

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
