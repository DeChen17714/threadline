import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material'
import type { JoinRequestSummary, Room } from '@threadline/shared'
import type { InvitationPort } from '../../services/invitations'
import { colors } from '../../app/theme'

type State = 'idle' | 'pending' | 'issued' | 'unavailable' | 'revoked' | 'error'

export function InviteDialog({ room, port, onClose }: { room: Room; port: InvitationPort; onClose: () => void }) {
  const [state, setState] = useState<State>('idle')
  const [link, setLink] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [replace, setReplace] = useState(false)
  const issueId = useRef(crypto.randomUUID())
  const revokeId = useRef(crypto.randomUUID())
  const retryAction = useRef<'issue' | 'revoke'>('issue')
  const busy = useRef(false)
  const epoch = useRef(0)

  const [requests, setRequests] = useState<readonly JoinRequestSummary[]>([])
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [requestsError, setRequestsError] = useState<string | null>(null)
  const [decisionPendingId, setDecisionPendingId] = useState<string | null>(null)
  const [decisionFeedback, setDecisionFeedback] = useState<string | null>(null)

  const decisionRequestIds = useRef(new Map<string, string>())
  const decidedIds = useRef(new Set<string>())


  async function loadRequests() {
    if (busy.current) return
    busy.current = true
    const ownEpoch = ++epoch.current
    setRequestsLoading(true)
    setRequestsError(null)
    try {
      const result = await port.list(room.id)
      if (ownEpoch !== epoch.current) return
      if (result.status === 'complete' && Array.isArray(result.joinRequests)) {
        setRequests(result.joinRequests.filter((r) => !decidedIds.current.has(r.joinRequestId)))
      } else {
        setRequests([])
      }
    } catch {
      if (ownEpoch !== epoch.current) return
      setRequestsError('Unable to load pending requests. Check your connection.')
    } finally {
      if (ownEpoch === epoch.current) {
        setRequestsLoading(false)
        busy.current = false
      }
    }
  }

  useEffect(() => {
    let active = true
    const currentEpoch = ++epoch.current

    void (async () => {
      if (busy.current) return
      busy.current = true
      setRequestsLoading(true)
      setRequestsError(null)
      try {
        const result = await port.list(room.id)
        if (!active || currentEpoch !== epoch.current) return
        if (result.status === 'complete' && Array.isArray(result.joinRequests)) {
          setRequests(result.joinRequests.filter((r) => !decidedIds.current.has(r.joinRequestId)))
        } else {
          setRequests([])
        }
      } catch {
        if (!active || currentEpoch !== epoch.current) return
        setRequestsError('Unable to load pending requests. Check your connection.')
      } finally {
        if (active && currentEpoch === epoch.current) {
          setRequestsLoading(false)
          busy.current = false
        }
      }
    })()

    return () => {
      active = false
      epoch.current++
      busy.current = false
    }
  }, [port, room.id])

  async function run(action: 'issue' | 'revoke', replacement = false) {
    if (busy.current) return
    busy.current = true
    const ownEpoch = ++epoch.current
    retryAction.current = action
    if (replacement) issueId.current = crypto.randomUUID()
    setReplace(false)
    setState('pending')
    setError(null)
    setCopied(false)
    setLink(null)
    setExpiresAt(null)
    try {
      const result = action === 'issue' ? await port.issue(room.id, issueId.current) : await port.revoke(room.id, revokeId.current)
      if (ownEpoch !== epoch.current) return
      if (result.status !== 'complete') throw new Error('The operation is not confirmed.')
      if (action === 'revoke') {
        setState('revoked')
        issueId.current = crypto.randomUUID()
        revokeId.current = crypto.randomUUID()
      } else if (result.tokenUnavailable) {
        setState('unavailable')
      } else if (result.token && typeof result.expiresAt === 'number') {
        setLink(`${window.location.origin}/join#${result.token}`)
        setExpiresAt(result.expiresAt)
        setState('issued')
      } else {
        throw new Error('No invitation link was confirmed. Retry safely.')
      }

      setRequests([])
      // Refresh pending requests after successful rotate or revoke
      setRequestsLoading(true)
      try {
        const freshList = await port.list(room.id)
        if (ownEpoch === epoch.current && freshList.status === 'complete' && Array.isArray(freshList.joinRequests)) {
          setRequests(freshList.joinRequests.filter((r) => !decidedIds.current.has(r.joinRequestId)))
        }
      } catch {
        if (ownEpoch === epoch.current) {
          setRequestsError('The invitation was updated, but pending requests could not be refreshed.')
        }
      }
    } catch {
      if (ownEpoch === epoch.current) {
        setState('error')
        setError('The invitation action is not confirmed. Retry uses the same operation and will not create a second link.')
      }
    } finally {
      if (ownEpoch === epoch.current) {
        setRequestsLoading(false)
        busy.current = false
      }
    }
  }

  async function copy() {
    if (!link) return
    const ownEpoch = epoch.current
    try {
      await navigator.clipboard.writeText(link)
      if (ownEpoch === epoch.current) setCopied(true)
    } catch {
      if (ownEpoch === epoch.current) setError('Clipboard access was denied. Select and copy the link below manually.')
    }
  }

  async function decide(joinRequestId: string, decision: 'approve' | 'reject') {
    if (busy.current) return
    busy.current = true
    const ownEpoch = ++epoch.current
    setDecisionPendingId(joinRequestId)
    setRequestsError(null)
    setDecisionFeedback(null)

    const key = `${joinRequestId}:${decision}`
    let decisionRequestId = decisionRequestIds.current.get(key)
    if (!decisionRequestId) {
      decisionRequestId = crypto.randomUUID()
      decisionRequestIds.current.set(key, decisionRequestId)
    }

    try {
      const result = await port.decide(room.id, joinRequestId, decision, decisionRequestId)
      if (ownEpoch !== epoch.current) return
      if (result.status !== 'complete' || !['approved', 'rejected', 'expired'].includes(result.joinStatus ?? '')) {
        throw new Error('Decision could not be confirmed.')
      }

      decisionRequestIds.current.delete(key)
      decidedIds.current.add(joinRequestId)
      setRequests((prev) => prev.filter((r) => r.joinRequestId !== joinRequestId))

      if (result.joinStatus === 'approved') {
        setDecisionFeedback('Access approved.')
      } else if (result.joinStatus === 'rejected') {
        setDecisionFeedback('Request rejected.')
      } else if (result.joinStatus === 'expired') {
        setDecisionFeedback('Request has expired.')
      }
    } catch {
      if (ownEpoch !== epoch.current) return
      setRequestsError(`Failed to ${decision} request. The request may have expired, or the room may be full.`)
    } finally {
      if (ownEpoch === epoch.current) {
        setDecisionPendingId(null)
        busy.current = false
      }
    }
  }

  const pending = state === 'pending'
  const occupied = pending || requestsLoading || decisionPendingId !== null

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy.current) onClose()
      }}
      maxWidth="xs"
      fullWidth
      aria-labelledby="invite-title"
      aria-describedby="invite-description"
      PaperProps={{ sx: { maxWidth: 460 } }}
      sx={{
        '& .MuiButton-text:not(.MuiButton-colorError), & .MuiButton-outlined:not(.MuiButton-colorError)': { color: 'text.primary' },
        '& .MuiButton-outlined:not(.MuiButton-colorError)': { borderColor: colors.inputBorder },
      }}
    >
      <DialogTitle id="invite-title" sx={{ px: { xs: 3, sm: 4 }, fontSize: '20px', fontWeight: 600, overflowWrap: 'anywhere' }}>
        Invite to {room.name}
      </DialogTitle>
      <DialogContent sx={{ px: { xs: 3, sm: 4 }, py: 1.5 }}>
        <Typography id="invite-description" sx={{ fontSize: '15px', color: 'text.secondary', mb: 2 }}>
          Private link expires in 24 hours (up to 20 members). Room owner approval required for each request.
        </Typography>

        {pending && (
          <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 1.5 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '13px' }}>
              Confirming invitation action…
            </Typography>
          </Box>
        )}

        {state === 'unavailable' && (
          <Alert severity="warning" sx={{ my: 1.5 }}>
            The invitation was issued, but its link cannot be recovered. Generate a replacement to revoke the previous link.
          </Alert>
        )}

        {state === 'revoked' && (
          <Alert severity="success" sx={{ my: 1.5 }}>
            The invitation is revoked. Existing members keep their access.
          </Alert>
        )}

        {link && (
          <Box sx={{ my: 2 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'stretch' }}>
              <TextField
                fullWidth
                size="small"
                label="Private invitation link"
                value={link}
                slotProps={{
                  input: {
                    readOnly: true,
                    sx: { fontFamily: '"IBM Plex Mono", monospace', fontSize: '13px' },
                  },
                }}
                sx={{ flex: '1 1 200px' }}
              />
              <Button
                variant="contained"
                onClick={() => void copy()}
                sx={{ minWidth: { xs: '100%', sm: 104 }, flex: { xs: '1 1 100%', sm: '0 0 auto' } }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '13px', mt: 0.75 }}>
              Expires {new Date(expiresAt!).toLocaleString()}
            </Typography>
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ my: 1.5 }}>
            {error}
          </Alert>
        )}

        {replace && (
          <Alert severity="warning" sx={{ my: 2 }}>
            <Typography variant="body2" sx={{ fontSize: '13px', mb: 1 }}>
              Replacing this invitation revokes the previous link. Pending requests under the previous link expire, and existing members keep their access.
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Button variant="contained" disabled={occupied} onClick={() => void run('issue', true)}>
                Confirm replacement
              </Button>
              <Button variant="outlined" onClick={() => setReplace(false)}>
                Keep current invitation
              </Button>
            </Box>
          </Alert>
        )}

        {!pending && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, my: 2, alignItems: 'center' }}>
            {(state === 'idle' || state === 'revoked') && (
              <Button variant="contained" disabled={occupied} onClick={() => void run('issue')}>
                Generate link
              </Button>
            )}
            {state === 'error' && (
              <Button variant="contained" disabled={occupied} onClick={() => void run(retryAction.current)}>
                Retry invitation action
              </Button>
            )}
            {(state === 'issued' || state === 'unavailable') && (
              <Button variant="outlined" disabled={occupied} onClick={() => setReplace(true)}>
                Generate replacement
              </Button>
            )}
            <Button variant="outlined" color="error" disabled={occupied} onClick={() => void run('revoke')}>
              Revoke invitation
            </Button>
          </Box>
        )}

        <Box sx={{ mt: 2.5, pt: 2, borderTop: `1px solid ${colors.dividerLight}` }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, gap: 1 }}>
            <Typography variant="h3" sx={{ fontSize: '16px', fontWeight: 600 }}>
              Pending access requests
            </Typography>
            <Button disabled={occupied} onClick={() => void loadRequests()}>
              {requestsLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </Box>

          {requestsLoading && (
            <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 1.5 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '13px' }}>
                Loading requests…
              </Typography>
            </Box>
          )}

          {decisionFeedback && (
            <Alert severity="success" sx={{ my: 1.5 }}>
              {decisionFeedback}
            </Alert>
          )}

          {requestsError && (
            <Alert severity="error" sx={{ my: 1.5 }}>
              {requestsError}
            </Alert>
          )}

          {!requestsLoading && requests.length === 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary', my: 1.5 }}>
              No pending access requests.
            </Typography>
          )}

          {!requestsLoading && requests.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
              {requests.map((req) => (
                <Box
                  key={req.joinRequestId}
                  sx={{
                    p: 2,
                    border: `1px solid ${colors.dividerLight}`,
                    borderRadius: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
                    <Typography sx={{ fontWeight: 600, fontSize: '15px', overflowWrap: 'anywhere' }}>
                      {req.applicantLabel}
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '13px', overflowWrap: 'anywhere', fontFamily: '"IBM Plex Mono", monospace' }}>
                      UID: {req.applicantUid}
                    </Typography>
                  </Box>
                  <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '13px' }}>
                    Expires {new Date(req.expiresAt).toLocaleString()}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                    <Button
                      variant="contained"
                      disabled={occupied}
                      onClick={() => void decide(req.joinRequestId, 'approve')}
                    >
                      {decisionPendingId === req.joinRequestId ? 'Saving…' : 'Approve'}
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      disabled={occupied}
                      onClick={() => void decide(req.joinRequestId, 'reject')}
                    >
                      Reject
                    </Button>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 3, sm: 4 }, py: 1.5, borderTop: `1px solid ${colors.dividerLight}` }}>
        <Button
          variant="outlined"
          disabled={occupied}
          onClick={() => {
            if (!busy.current) onClose()
          }}
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
