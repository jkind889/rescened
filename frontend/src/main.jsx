import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import '@fontsource/fragment-mono/400.css'
import '@fontsource/fragment-mono/400-italic.css'
import './index.css'
import App from './App.jsx'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in the frontend environment.')
}

// Route chunks are hashed per deploy. If an open tab asks for a chunk that a newer
// deploy replaced, reload once to pick up the new build. The timestamp guard keeps
// a persistent failure from turning into a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'rescened-chunk-reload-at'
  try {
    const last = Number(sessionStorage.getItem(key)) || 0
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  </StrictMode>,
)
