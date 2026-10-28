import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Onboarding } from './Onboarding'
import { Settings } from './Settings'
import { initPort } from './store'
import './styles.css'

if (location.hash !== '#settings' && location.hash !== '#onboarding') initPort()
createRoot(document.getElementById('root') as HTMLElement).render(
  location.hash === '#settings' ? (
    <Settings />
  ) : location.hash === '#onboarding' ? (
    <Onboarding />
  ) : (
    <App />
  ),
)
