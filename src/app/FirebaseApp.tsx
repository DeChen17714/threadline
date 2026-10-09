import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import type { AuthPort, AuthUser } from '../services/auth'
import { initializeFirebase } from '../services/firebase'
import { LandingPage } from '../features/landing/LandingPage'
import { staticLandingPort } from '../services/landing'
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage'
import { AuthPage } from '../features/auth/AuthPage'
import { navigate, privateDestination } from './routes'
import { WorkspacePage } from '../features/workspace/WorkspacePage'
import type { WorkspacePort } from '../services/workspace'
import type { InvitationPort } from '../services/invitations'
import { clearInviteIntent, readInviteIntent } from '../services/inviteIntent'
import { JoinPage } from '../features/invitations/JoinPage'
import type { MaintenancePort } from '../services/maintenance'

const services = initializeFirebase()

function AccountWorkspace({ auth, user, roomId, workspace, invitations, maintenance }: { auth: AuthPort; user: AuthUser; roomId: string | null; workspace: (user: AuthUser) => WorkspacePort; invitations: InvitationPort; maintenance: MaintenancePort }) {
  const port = useMemo(() => workspace(user), [workspace, user])
  const storageKey = `threadline:last-room:${user.uid}`
  useEffect(() => () => port.dispose?.(), [port])
  useEffect(() => {
    let active = true
    let saved: string | null = null
    try { saved = localStorage.getItem(storageKey) } catch { /* Storage may be disabled. */ }
    const candidate = roomId ?? saved
    if (!candidate || !/^[a-zA-Z0-9-]+$/.test(candidate)) return
    const unsubscribe = port.subscribeRoom(candidate, (state) => {
      if (!active || state.status === 'loading') return
      if (state.status === 'ready' && state.data?.members.some((member) => member.uid === user.uid)) {
        try { localStorage.setItem(storageKey, candidate) } catch { /* Selection is optional. */ }
        if (!roomId && window.location.pathname === '/workspace') navigate(`/rooms/${candidate}`, true)
      } else {
        try { localStorage.removeItem(storageKey) } catch { /* Selection is optional. */ }
      }
    })
    return () => { active = false; unsubscribe() }
  }, [port, roomId, storageKey, user.uid])
  return <WorkspacePage port={port} invitations={invitations} maintenance={maintenance} roomId={roomId} accountEmail={user.email ?? user.label} onSignOut={() => auth.signOut()} onSelectRoom={(id) => navigate(id ? `/rooms/${id}` : '/workspace')} onHome={() => navigate('/')} />
}

function SignedInJoin({ invitations, onReturn }: { invitations: InvitationPort; onReturn: () => void }) {
  const token = readInviteIntent()
  return <JoinPage port={invitations} token={token} onJoined={(roomId) => { clearInviteIntent(); navigate(`/rooms/${roomId}`, true) }} onReturn={() => { clearInviteIntent(); onReturn() }} />
}

function ConnectedApp({ auth, workspace, invitations, maintenance, route, routeRevision }: { auth: AuthPort; workspace: (user: AuthUser) => WorkspacePort; invitations: (user: AuthUser) => InvitationPort; maintenance: (user: AuthUser) => MaintenancePort; route: string; routeRevision: number }) {
  const session = useSyncExternalStore(auth.subscribe, auth.getSnapshot)
  const user = session.status === 'signed-in' ? session.user : null
  const invitePort = useMemo(() => user ? invitations(user) : null, [invitations, user])
  const maintenancePort = useMemo(() => user ? maintenance(user) : null, [maintenance, user])
  const url = new URL(route, window.location.origin)
  const path = url.pathname
  const roomMatch = /^\/rooms\/([a-zA-Z0-9-]+)$/.exec(path)
  const privateRoute = path === '/workspace' || path === '/join' || roomMatch !== null
  const destination = privateDestination(url.searchParams.get('next'))
  const loginRoute = `/auth?mode=login&next=${encodeURIComponent(destination)}`
  const recoveryRoute = `/auth/forgot-password?next=${encodeURIComponent(destination)}`
  useEffect(() => {
    if (privateRoute && (session.status === 'signed-out' || session.status === 'link-required')) navigate(`/auth?mode=login&next=${encodeURIComponent(path)}`, true)
    if (path === '/auth' && session.status === 'signed-in') navigate(destination, true)
  }, [session, path, privateRoute, destination])
  if (path === '/') return <LandingPage chapters={staticLandingPort.chapters} signedIn={session.status === 'signed-in'} />
  if (session.status === 'error') return <Box component="main" sx={{ p: 6 }}><Alert severity="error">{session.message}</Alert><Button onClick={() => auth.retry()}>Retry connection</Button></Box>
  if (session.status === 'loading' || (privateRoute && session.status !== 'signed-in') || (path === '/auth' && session.status === 'signed-in')) return <Box component="main" role="status" sx={{ p: 8 }}><CircularProgress size={24} /> Checking your session…</Box>
  if (path === '/auth/forgot-password') return <ForgotPasswordPage auth={auth} onReturnToLogin={() => navigate(loginRoute)} />
  if (path === '/auth/reset-password') {
    const code = url.searchParams.get('mode') === 'resetPassword' ? url.searchParams.get('oobCode') : null
    return <ResetPasswordPage key={code ?? 'unsupported-action'} auth={auth} code={code} onPasswordChanged={() => navigate(loginRoute, true)} onRestart={() => navigate(recoveryRoute, true)} />
  }
  if (path === '/auth') return <AuthPage key={session.status === 'link-required' ? `link:${session.email}:${session.user?.uid ?? 'unverified'}` : 'credentials'} auth={auth} mode={url.searchParams.get('mode') === 'signup' ? 'signup' : 'login'} onModeChange={(mode) => navigate(`/auth?mode=${mode}&next=${encodeURIComponent(destination)}`)} onForgotPassword={() => navigate(recoveryRoute)} />
  if (path === '/join' && session.status === 'signed-in' && invitePort) return <SignedInJoin key={`${session.user.uid}:${routeRevision}`} invitations={invitePort} onReturn={() => navigate('/workspace', true)} />
  if (privateRoute && session.status === 'signed-in' && invitePort && maintenancePort) return <AccountWorkspace key={session.user.uid} auth={auth} user={session.user} workspace={workspace} invitations={invitePort} maintenance={maintenancePort} roomId={roomMatch?.[1] ?? null} />
  return <Box component="main" sx={{ p: 8 }}><Typography variant="h2">Page not found</Typography><Button onClick={() => navigate('/workspace')}>Return to workspace</Button></Box>
}

export default function FirebaseApp({ route, routeRevision }: { route: string; routeRevision: number }) {
  if ('error' in services) {
    if (new URL(route, window.location.origin).pathname === '/') return <LandingPage chapters={staticLandingPort.chapters} signedIn={false} />
    return <Box component="main" sx={{ p: 6, maxWidth: 680, mx: 'auto' }}><Typography variant="h2" sx={{ fontSize: 32, mb: 4 }}>Workspace not connected</Typography><Alert severity="error">{services.error}</Alert><Button onClick={() => window.location.reload()}>Retry setup</Button><Button href="/">Return to introduction</Button></Box>
  }
  return <ConnectedApp auth={services.auth} workspace={services.workspace} invitations={services.invitations} maintenance={services.maintenance} route={route} routeRevision={routeRevision} />
}
