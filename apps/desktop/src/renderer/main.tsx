import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Settings } from './Settings'
import { initPort } from './store'
import './styles.css'

if (location.hash !== '#settings') initPort()
createRoot(document.getElementById('root') as HTMLElement).render(
  location.hash === '#settings' ? <Settings /> : <App />,
)
