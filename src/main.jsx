import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ExecutionProvider } from './contexts/ExecutionContext'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ExecutionProvider>
      <App />
    </ExecutionProvider>
  </StrictMode>,
)
