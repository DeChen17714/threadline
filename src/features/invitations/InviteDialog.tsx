import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material'
import type { Room } from '@threadline/shared'
import type { InvitationPort } from '../../services/invitations'

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
  useEffect(() => () => { epoch.current++ }, [])

  async function run(action: 'issue' | 'revoke', replacement = false) {
    if (busy.current) return
    busy.current = true
    const ownEpoch = epoch.current
    retryAction.current = action
    if (replacement) issueId.current = crypto.randomUUID()
    setReplace(false); setState('pending'); setError(null); setCopied(false); setLink(null); setExpiresAt(null)
    try {
      const result = action === 'issue' ? await port.issue(room.id, issueId.current) : await port.revoke(room.id, revokeId.current)
      if (ownEpoch !== epoch.current) return
      if (result.status !== 'complete') throw new Error('The operation is not confirmed.')
      if (action === 'revoke') {
        setState('revoked'); issueId.current = crypto.randomUUID(); revokeId.current = crypto.randomUUID()
      } else if (result.tokenUnavailable) setState('unavailable')
      else if (result.token && typeof result.expiresAt === 'number') {
        setLink(`${window.location.origin}/join#${result.token}`); setExpiresAt(result.expiresAt); setState('issued')
      } else throw new Error('No invitation link was confirmed. Retry safely.')
    } catch {
      if (ownEpoch === epoch.current) { setState('error'); setError('The invitation action is not confirmed. Retry uses the same operation and will not create a second link.') }
    } finally {
      if (ownEpoch === epoch.current) busy.current = false
    }
  }
  async function copy() {
    if (!link) return
    const ownEpoch = epoch.current
    try { await navigator.clipboard.writeText(link); if (ownEpoch === epoch.current) setCopied(true) }
    catch { if (ownEpoch === epoch.current) setError('Clipboard access was denied. Select and copy the link below manually.') }
  }
  const pending = state === 'pending'
  return <Dialog open onClose={() => { if (!busy.current) onClose() }} maxWidth="xs" fullWidth aria-labelledby="invite-title" aria-describedby="invite-description" sx={{ '& .MuiButton-text:not(.MuiButton-colorError)': { color: 'text.primary' } }}>
    <DialogTitle id="invite-title" sx={{ overflowWrap: 'anywhere' }}>Invite to {room.name}</DialogTitle>
    <DialogContent>
      <Typography id="invite-description" sx={{ mb: 3 }}>A private link admits authenticated people, up to 20 members. It expires after 24 hours. Generating a link replaces any previous invitation.</Typography>
      {pending && <Box role="status"><CircularProgress size={24} /> Confirming invitation action…</Box>}
      {state === 'unavailable' && <Alert severity="warning">The invitation was issued, but its link cannot be recovered. Generate a replacement to revoke the previous link.</Alert>}
      {state === 'revoked' && <Alert severity="success">The invitation is revoked. Existing members keep their access.</Alert>}
      {link && <><TextField fullWidth label="Private invitation link" value={link} slotProps={{ input: { readOnly: true } }} sx={{ my: 3 }} /><Typography sx={{ mb: 2 }}>Expires {new Date(expiresAt!).toLocaleString()}</Typography><Button variant="contained" onClick={() => void copy()} sx={{ minHeight: 44 }}>{copied ? 'Copied' : 'Copy link'}</Button></>}
      {error && <Alert severity="error" sx={{ my: 3 }}>{error}</Alert>}
      {replace && <Alert severity="warning" sx={{ my: 3 }}>Replacing this invitation revokes the previous link. People already in the room keep their membership.<Button onClick={() => void run('issue', true)} sx={{ minHeight: 44 }}>Confirm replacement</Button><Button onClick={() => setReplace(false)} sx={{ minHeight: 44 }}>Keep current invitation</Button></Alert>}
      {!pending && <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 3 }}>
        {(state === 'idle' || state === 'revoked') && <Button variant="contained" onClick={() => void run('issue')} sx={{ minHeight: 44 }}>Generate link</Button>}
        {state === 'error' && <Button onClick={() => void run(retryAction.current)} sx={{ minHeight: 44 }}>Retry invitation action</Button>}
        {(state === 'issued' || state === 'unavailable') && <Button onClick={() => setReplace(true)} sx={{ minHeight: 44 }}>Generate replacement</Button>}
        <Button color="error" onClick={() => void run('revoke')} sx={{ minHeight: 44 }}>Revoke invitation</Button>
      </Box>}
    </DialogContent>
    <DialogActions><Button disabled={pending} onClick={onClose} sx={{ minHeight: 44 }}>Done</Button></DialogActions>
  </Dialog>
}
