import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material'
import type { CommandResult, Room } from '@threadline/shared'
import type { MaintenancePort } from '../../services/maintenance'

export interface DeleteRoomDialogProps {
  readonly room: Room
  readonly port: MaintenancePort
  readonly onClose: () => void
  readonly onAdmitted: (result: CommandResult) => void
}

type DialogState = 'idle' | 'pending' | 'error'

export function DeleteRoomDialog({
  room,
  port,
  onClose,
  onAdmitted,
}: DeleteRoomDialogProps) {
  const [state, setState] = useState<DialogState>('idle')
  const [error, setError] = useState<string | null>(null)

  const busy = useRef(false)
  const epoch = useRef(0)
  const deleteRequestId = useRef(crypto.randomUUID())

  useEffect(() => {
    const mountedEpoch = epoch.current
    return () => { epoch.current = mountedEpoch + 1 }
  }, [])

  async function handleDelete() {
    if (busy.current) return
    busy.current = true
    const ownEpoch = epoch.current

    setState('pending')
    setError(null)

    try {
      const result = await port.deleteRoom(room.id, deleteRequestId.current)
      if (ownEpoch !== epoch.current) return

      if (result.status === 'cancelled') {
        throw new Error('Room deletion was cancelled.')
      }

      onAdmitted(result)
    } catch (err) {
      if (ownEpoch === epoch.current) {
        setState('error')
        setError(
          err instanceof Error
            ? err.message
            : 'Deletion request failed. Retry uses the same request ID.',
        )
      }
    } finally {
      if (ownEpoch === epoch.current) {
        busy.current = false
      }
    }
  }

  const isPending = state === 'pending'

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy.current) {
          onClose()
        }
      }}
      maxWidth="xs"
      fullWidth
      aria-labelledby="delete-room-title"
      aria-describedby="delete-room-description"
      sx={{
        '& .MuiButton-text:not(.MuiButton-colorError)': {
          color: 'text.primary',
        },
      }}
    >
      <DialogTitle id="delete-room-title" sx={{ overflowWrap: 'anywhere' }}>
        Delete room “{room.name}”?
      </DialogTitle>

      <DialogContent>
        <Typography id="delete-room-description" sx={{ mb: 2 }}>
          This action is permanent and cannot be undone. All messages, invitations,
          and conversation history in this room will be permanently deleted.
        </Typography>

        {isPending && (
          <Box
            role="status"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              my: 2,
            }}
          >
            <CircularProgress size={24} />
            <Typography variant="body2">Starting room deletion…</Typography>
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>
        <Button
          onClick={onClose}
          disabled={isPending}
          sx={{ minHeight: 44, color: 'text.primary' }}
        >
          Cancel
        </Button>

        {state === 'error' ? (
          <Button
            variant="contained"
            color="error"
            onClick={() => void handleDelete()}
            disabled={isPending}
            sx={{ minHeight: 44 }}
          >
            Retry deletion
          </Button>
        ) : (
          <Button
            variant="contained"
            color="error"
            onClick={() => void handleDelete()}
            disabled={isPending}
            sx={{ minHeight: 44 }}
          >
            Delete room
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
