import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Paper, Typography } from '@mui/material'
import type { InvitationPort } from '../../services/invitations'
import { clearInviteIntent, clearJoinRequestIdentity, readJoinRequestIdentity, saveJoinRequestIdentity } from '../../services/inviteIntent'
import { colors } from '../../app/theme'

export interface JoinPageProps {
  readonly port: InvitationPort
  readonly token: string | null
  readonly onJoined: (roomId: string) => void
  readonly onReturn: () => void
  readonly uid: string
}

type JoinPageState =
  | 'idle'
  | 'submitting'
  | 'loading-status'
  | 'pending'
  | 'checking'
  | 'unconfirmed'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'invalid'

function classifyAdmissionError(error: unknown): { denied: boolean; message: string } {
  if (error instanceof Error) {
    const code = 'code' in error ? String(error.code) : ''
    const details = 'details' in error && error.details && typeof error.details === 'object'
      ? error.details as { code?: unknown; retryAt?: unknown }
      : null
    if (details?.code === 'throttled') {
      const retryAt = details.retryAt
      const message = typeof retryAt === 'number' && Number.isFinite(retryAt)
        ? `Too many access requests. Try again after ${new Date(retryAt).toLocaleString()}.`
        : 'Too many access requests. Please try again later.'
      return { denied: true, message }
    }
    if (details?.code === 'room-busy') {
      return { denied: true, message: 'This room cannot accept more access requests right now.' }
    }
    if (['functions/permission-denied', 'functions/invalid-argument', 'functions/failed-precondition', 'functions/not-found', 'functions/already-exists'].includes(code)) {
      return { denied: true, message: 'Admission was denied. The invitation may be invalid, expired, or revoked.' }
    }
  }
  return { denied: false, message: 'Your join request is unconfirmed. Check your connection and retry.' }
}

export function JoinPage({ port, token, onJoined, onReturn, uid }: JoinPageProps) {
  const validToken = Boolean(token && /^[A-Za-z0-9_-]{43}$/.test(token))

  const [joinRequestId, setJoinRequestId] = useState<string | null>(() => {
    if (!validToken || !token) return null
    return readJoinRequestIdentity(token, uid)
  })

  const [status, setStatus] = useState<JoinPageState>(() => {
    if (!validToken) return 'invalid'
    if (token && readJoinRequestIdentity(token, uid)) return 'loading-status'
    return 'idle'
  })

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const busy = useRef(false)
  const epoch = useRef(0)

  useEffect(() => {
    let active = true
    const currentEpoch = ++epoch.current

    const rememberedId = validToken && token ? readJoinRequestIdentity(token, uid) : null
    if (validToken && token && rememberedId) {
      void (async () => {
        try {
          const result = await port.status(rememberedId)
          if (!active || currentEpoch !== epoch.current) return
          if (result.status !== 'complete') throw new Error('Unconfirmed')

          if (result.joinStatus === 'approved' && result.roomId) {
            clearJoinRequestIdentity(token, uid)
            clearInviteIntent()
            setStatus('approved')
            onJoined(result.roomId)
            return
          }
          if (result.joinStatus === 'rejected') {
            clearJoinRequestIdentity(token, uid)
            setJoinRequestId(null)
            setStatus('rejected')
            return
          }
          if (result.joinStatus === 'expired') {
            clearJoinRequestIdentity(token, uid)
            setJoinRequestId(null)
            setStatus('expired')
            return
          }
          if (result.joinStatus === 'pending') {
            setStatus('pending')
            return
          }
          setStatus('unconfirmed')
          setError('Your join request is unconfirmed. Check your connection or retry.')
        } catch {
          if (!active || currentEpoch !== epoch.current) return
          setStatus('unconfirmed')
          setError('Your join request is unconfirmed. Check your connection or retry.')
        }
      })()
    }

    return () => {
      active = false
      epoch.current++
      busy.current = false
    }
  }, [port, token, uid, validToken, onJoined])

  async function requestAccess() {
    if (busy.current || !token || !validToken) return
    busy.current = true
    const ownEpoch = ++epoch.current
    setStatus('submitting')
    setError(null)
    setNotice(null)

    const reqId = joinRequestId ?? crypto.randomUUID()
    saveJoinRequestIdentity(token, reqId, uid)
    setJoinRequestId(reqId)

    try {
      const result = await port.request(token, reqId)
      if (ownEpoch !== epoch.current) return

      if (result.status !== 'complete') throw new Error('Unconfirmed')

      if (result.joinStatus === 'approved' && result.roomId) {
        clearJoinRequestIdentity(token, uid)
        clearInviteIntent()
        setStatus('approved')
        onJoined(result.roomId)
        return
      }

      if (result.joinStatus === 'rejected') {
        clearJoinRequestIdentity(token, uid)
        setJoinRequestId(null)
        setStatus('rejected')
        return
      }

      if (result.joinStatus === 'expired') {
        clearJoinRequestIdentity(token, uid)
        setJoinRequestId(null)
        setStatus('expired')
        return
      }

      if (result.joinStatus === 'pending') {
        const confirmedId = result.joinRequestId ?? reqId
        setJoinRequestId(confirmedId)
        saveJoinRequestIdentity(token, confirmedId, uid)
        setStatus('pending')
        return
      }

      setStatus('unconfirmed')
      setError('Your join request is unconfirmed. Check your connection or retry.')
    } catch (failure) {
      if (ownEpoch !== epoch.current) return

      const classification = classifyAdmissionError(failure)
      if (classification.denied) {
        clearJoinRequestIdentity(token, uid)
        setJoinRequestId(null)
        setStatus('idle')
        setError(classification.message)
      } else {
        setStatus('unconfirmed')
        setError(classification.message)
      }
    } finally {
      if (ownEpoch === epoch.current) {
        busy.current = false
      }
    }
  }

  async function checkStatus() {
    if (busy.current || !joinRequestId) return
    busy.current = true
    const ownEpoch = ++epoch.current
    setStatus('checking')
    setError(null)
    setNotice(null)

    try {
      const result = await port.status(joinRequestId)
      if (ownEpoch !== epoch.current) return

      if (result.status !== 'complete') throw new Error('Unconfirmed')

      if (result.joinStatus === 'approved' && result.roomId) {
        if (token) clearJoinRequestIdentity(token, uid)
        clearInviteIntent()
        setStatus('approved')
        onJoined(result.roomId)
        return
      }

      if (result.joinStatus === 'rejected') {
        if (token) clearJoinRequestIdentity(token, uid)
        setJoinRequestId(null)
        setStatus('rejected')
        return
      }

      if (result.joinStatus === 'expired') {
        if (token) clearJoinRequestIdentity(token, uid)
        setJoinRequestId(null)
        setStatus('expired')
        return
      }

      if (result.joinStatus === 'pending') {
        setStatus('pending')
        setNotice('Your request is still awaiting room owner approval.')
        return
      }

      setStatus('unconfirmed')
      setError('We could not verify the status of your join request. You can check again or retry.')
    } catch {
      if (ownEpoch !== epoch.current) return
      setStatus('unconfirmed')
      setError('We could not verify the status of your join request. You can check again or retry.')
    } finally {
      if (ownEpoch === epoch.current) {
        busy.current = false
      }
    }
  }

  const isPendingOperation = status === 'submitting' || status === 'checking' || status === 'loading-status'

  return (
    <Box component="main" sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', bgcolor: colors.paper, p: 3 }}>
      <Paper variant="outlined" sx={{ maxWidth: 480, width: '100%', p: { xs: 4, sm: 6 }, borderRadius: 3, '& .MuiButton-text': { color: colors.ink } }}>
        <Typography sx={{ color: colors.inkSecondary, mb: 3 }}>Threadline</Typography>

        {status === 'invalid' && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Invitation unavailable</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>This link is invalid, expired, revoked, or the room is unavailable.</Typography>
          </>
        )}

        {status === 'loading-status' && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Checking invitation</Typography>
            <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 2 }}>
              <CircularProgress size={24} />
              <Typography>Checking request status…</Typography>
            </Box>
          </>
        )}

        {(status === 'idle' || status === 'submitting') && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Request access</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>This room is private. Submit a request to ask the room owner for admission.</Typography>
            {status === 'submitting' ? (
              <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 2 }}>
                <CircularProgress size={24} />
                <Typography>Submitting request…</Typography>
              </Box>
            ) : (
              <Button variant="contained" disabled={isPendingOperation} onClick={() => void requestAccess()} sx={{ minHeight: 44 }}>
                Request access
              </Button>
            )}
          </>
        )}

        {(status === 'pending' || status === 'checking') && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Access request pending</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>Your request has been submitted and is awaiting approval from the room owner.</Typography>
            {status === 'checking' ? (
              <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 2 }}>
                <CircularProgress size={24} />
                <Typography>Checking status…</Typography>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                <Button variant="contained" disabled={isPendingOperation} onClick={() => void checkStatus()} sx={{ minHeight: 44 }}>
                  Check status
                </Button>
                <Button disabled={isPendingOperation} onClick={() => void requestAccess()} sx={{ minHeight: 44 }}>
                  Retry request
                </Button>
              </Box>
            )}
          </>
        )}

        {status === 'unconfirmed' && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Request unconfirmed</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>We could not verify the status of your join request. You can check again or retry.</Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
              <Button variant="contained" disabled={isPendingOperation} onClick={() => void checkStatus()} sx={{ minHeight: 44 }}>
                Check status
              </Button>
              <Button disabled={isPendingOperation} onClick={() => void requestAccess()} sx={{ minHeight: 44 }}>
                Retry request
              </Button>
            </Box>
          </>
        )}

        {status === 'approved' && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Access approved</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>Your request was approved. Joining room…</Typography>
          </>
        )}

        {status === 'rejected' && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Access denied</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>Your request to join was not approved by the room owner.</Typography>
          </>
        )}

        {status === 'expired' && (
          <>
            <Typography variant="h2" sx={{ fontSize: 28, mb: 2 }}>Invitation expired</Typography>
            <Typography sx={{ mb: 4, color: colors.inkSecondary }}>This invitation link or request has expired.</Typography>
          </>
        )}

        {notice && <Alert severity="info" sx={{ my: 3 }}>{notice}</Alert>}
        {error && <Alert severity="error" sx={{ my: 3 }}>{error}</Alert>}

        <Button onClick={onReturn} disabled={isPendingOperation} sx={{ display: 'block', mt: 3, minHeight: 44 }}>
          Return to workspace
        </Button>
      </Paper>
    </Box>
  )
}
