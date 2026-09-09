import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.js'
import './styles.css'

// The service worker is what makes this installable and what receives push notifications.
// ⚠️ Registration fails on a plain-HTTP address, which is not a secure context — that is expected,
// and the app says so on the Attention screen rather than looking broken.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // A missing worker must never break the app itself.
    })
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('mobile root element is missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
