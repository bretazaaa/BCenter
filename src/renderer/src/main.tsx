import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Splash } from './splash/Splash'
import './styles.css'

const route = window.location.hash.replace(/^#/, '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{route === '/splash' ? <Splash /> : <App />}</StrictMode>,
)
