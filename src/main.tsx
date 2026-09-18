/**
 * Entry point. Mounts the shell and pulls in the single stylesheet.
 *
 * Deliberately NOT wrapped in <StrictMode>: strict mode double-invokes effects in
 * dev, which here would open two webcam streams and two realtime WebSockets. The
 * demo IS the product, so we take real single-mount behaviour over the extra
 * lint-by-runtime.
 */
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const host = document.getElementById('root')
if (!host) {
  throw new Error('SPOTTER: #root is missing from index.html — nothing to mount into.')
}

createRoot(host).render(<App />)
