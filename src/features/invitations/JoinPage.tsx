import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Paper, Typography } from '@mui/material'
import type { InvitationPort } from '../../services/invitations'
import { clearInviteIntent } from '../../services/inviteIntent'
import { colors } from '../../app/theme'

type Preview = { status: 'loading' | 'invalid' | 'error' } | { status: 'ready'; room: { id: string; name: string; description: string; memberCount: number } }
function transient(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'].includes(String(error.code))
}
export function JoinPage({ port, token, onJoined, onReturn }: { port: InvitationPort; token: string | null; onJoined: (roomId: string) => void; onReturn: () => void }) {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const epoch = useRef(0)
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    const ownEpoch = ++epoch.current
    void (async () => {
      try {
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid invitation')
        const result = await port.preview(token)
        if (ownEpoch !== epoch.current) return
        if (result.status !== 'complete' || !result.room) throw new Error('Invalid invitation')
        setPreview({ status: 'ready', room: result.room })
      } catch (failure) {
        if (ownEpoch !== epoch.current) return
        if (transient(failure)) setPreview({ status: 'error' })
        else { clearInviteIntent(); setPreview({ status: 'invalid' }) }
      }
    })()
    return () => { epoch.current = ownEpoch + 1; busy.current = false }
  }, [port, token, attempt])

  async function join() {
    if (busy.current || !token || preview.status !== 'ready') return
    busy.current = true
    const ownEpoch = epoch.current
    setPending(true); setError(null)
    try {
      const result = await port.join(token, requestId.current)
      if (ownEpoch !== epoch.current) return
      if (result.status !== 'complete' || !result.roomId) throw new Error('Admission not confirmed')
      clearInviteIntent(); onJoined(result.roomId)
    } catch (failure) {
      if (ownEpoch !== epoch.current) return
      if (transient(failure)) setError('Your join request is not confirmed. Check your connection and retry safely.')
      else { clearInviteIntent(); setPreview({ status: 'invalid' }); setError('Admission was denied. The link may have expired, been revoked, or the room may be full.') }
    } finally {
      if (ownEpoch === epoch.current) { busy.current = false; setPending(false) }
    }
  }
  return <Box component="main" sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', bgcolor: colors.paper, p: 3 }}>
    <Paper variant="outlined" sx={{ maxWidth: 480, width: '100%', p: { xs: 4, sm: 6 }, borderRadius: 3, '& .MuiButton-text': { color: colors.ink } }}>
      <Typography sx={{ color: colors.inkSecondary, mb: 3 }}>Threadline</Typography>
      {preview.status === 'loading' ? <Box role="status"><CircularProgress size={24} /> Checking invitation…</Box>
        : preview.status === 'ready' ? <><Typography variant="h2" sx={{ fontSize: 28, overflowWrap: 'anywhere' }}>{preview.room.name}</Typography><Typography sx={{ my: 3, overflowWrap: 'anywhere' }}>{preview.room.description}</Typography><Typography sx={{ mb: 4 }}>{preview.room.memberCount} members · Private room</Typography><Button variant="contained" disabled={pending} onClick={() => void join()} sx={{ minHeight: 44 }}>{pending ? 'Joining…' : 'Join room'}</Button></>
        : <><Typography variant="h2" sx={{ fontSize: 28 }}>{preview.status === 'error' ? 'Unable to check invitation' : 'Invitation unavailable'}</Typography><Typography sx={{ my: 3 }}>{preview.status === 'error' ? 'Check your connection and retry.' : 'This link is invalid, expired, revoked, or the room is unavailable.'}</Typography>{preview.status === 'error' && <Button onClick={() => { setPreview({ status: 'loading' }); setAttempt((n) => n + 1) }} sx={{ minHeight: 44 }}>Retry invitation</Button>}</>}
      {error && <Alert severity="error" sx={{ my: 3 }}>{error}</Alert>}
      <Button onClick={onReturn} disabled={pending} sx={{ display: 'block', mt: 3, minHeight: 44 }}>Return to workspace</Button>
    </Paper>
  </Box>
}
