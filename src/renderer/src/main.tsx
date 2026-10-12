import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root'
import { ConfirmationHost } from './components/ConfirmationHost'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Root />
    <ConfirmationHost />
  </StrictMode>
)
