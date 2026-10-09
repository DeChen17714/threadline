import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const requestedMode = loadEnv(mode, process.cwd(), '').VITE_APP_MODE
  const appMode = requestedMode ?? (mode === 'demo' ? 'demo' : 'firebase')
  if (appMode !== 'demo' && appMode !== 'firebase') throw new Error('VITE_APP_MODE must be demo or firebase.')
  if (mode !== 'demo' && appMode === 'demo') throw new Error('Demo composition is forbidden in release builds. Use the explicit demo mode.')
  return {
    plugins: [react()],
    publicDir: '.runtime-public',
    define: { 'import.meta.env.VITE_APP_MODE': JSON.stringify(appMode) },
  }
})
