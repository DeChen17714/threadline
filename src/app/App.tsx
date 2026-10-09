import { lazy, Suspense, useSyncExternalStore } from 'react'
import { Alert, Box, Button, CircularProgress, CssBaseline, ThemeProvider, Typography } from '@mui/material'
import { LandingPage } from '../features/landing/LandingPage'
import { staticLandingPort } from '../services/landing'
import { threadlineTheme } from './theme'
import { navigate, routeSnapshot, subscribeRoute } from './routes'

const DemoApp = import.meta.env.VITE_APP_MODE === 'demo' ? lazy(() => import('./DemoApp')) : null

const FirebaseApp = import.meta.env.VITE_APP_MODE === 'firebase' ? lazy(() => import('./FirebaseApp')) : null

export function App() {
  const route = useSyncExternalStore(subscribeRoute, routeSnapshot)
  const path = new URL(route.url, window.location.origin).pathname
  const match = /^\/rooms\/([a-zA-Z0-9-]+)$/.exec(path)
  const workspace = path === '/workspace' || match !== null
  return (
    <ThemeProvider theme={threadlineTheme}>
      <CssBaseline />
      {FirebaseApp ? (
        <Suspense fallback={<Box role="status" sx={{ p: 8 }}><CircularProgress size={24} /> Connecting…</Box>}><FirebaseApp route={route.url} routeRevision={route.revision} /></Suspense>
      ) : path === '/' ? <LandingPage chapters={staticLandingPort.chapters} onTryPreview={() => navigate('/workspace')} /> : workspace && DemoApp ? (
        <Suspense fallback={<Box role="status" sx={{ p: 8 }}><CircularProgress size={24} /> Loading local preview…</Box>}>
          <DemoApp roomId={match?.[1] ?? null} onSelectRoom={(id) => navigate(`/rooms/${id}`)} onHome={() => navigate('/')} />
        </Suspense>
      ) : (
        <Box component="main" sx={{ p: 8, maxWidth: 600, mx: 'auto' }}>
          <Typography variant="h2" sx={{ fontSize: 32, mb: 6 }}>Page not found</Typography>
          <Alert severity="info" sx={{ mb: 6 }}>This address does not have a Threadline page.</Alert>
          <Button variant="contained" onClick={() => navigate('/')}>Return to introduction</Button>
        </Box>
      )}
    </ThemeProvider>
  )
}
