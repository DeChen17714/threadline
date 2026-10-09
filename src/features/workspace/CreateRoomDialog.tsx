import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material'
import type { Room } from '@threadline/shared'
import { colors } from '../../app/theme'

export interface CreateRoomDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreateRoom: (input: { name: string; description: string }) => Promise<Room>
  readonly onRoomCreated: (room: Room) => void
}

export function CreateRoomDialog({ open, onClose, onCreateRoom, onRoomCreated }: CreateRoomDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [descError, setDescError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submission = useRef(false)
  const epoch = useRef(0)
  useEffect(() => () => { epoch.current++; submission.current = false }, [])

  function handleClose() {
    if (submission.current) return
    setName('')
    setDescription('')
    setNameError(null)
    setDescError(null)
    setSubmitError(null)
    onClose()
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submission.current) return
    const trimmedName = name.trim()
    let hasError = false

    if (!trimmedName) {
      setNameError('Room name is required (1–80 characters).')
      hasError = true
    } else if (trimmedName.length > 80) {
      setNameError('Room name must be 80 characters or fewer.')
      hasError = true
    } else {
      setNameError(null)
    }

    if (description.length > 500) {
      setDescError('Description must be 500 characters or fewer.')
      hasError = true
    } else {
      setDescError(null)
    }

    if (hasError) return
    submission.current = true
    const ownEpoch = epoch.current

    try {
      setSubmitting(true)
      setSubmitError(null)
      const created = await onCreateRoom({
        name: trimmedName,
        description: description.trim(),
      })
      if (ownEpoch !== epoch.current) return
      setName('')
      setDescription('')
      setNameError(null)
      setDescError(null)
      setSubmitError(null)
      onRoomCreated(created)
    } catch (err) {
      if (ownEpoch !== epoch.current) return
      // Preserve failed values and show inline error
      setSubmitError(err instanceof Error ? err.message : 'Unable to create room. Please try again.')
    } finally {
      if (ownEpoch === epoch.current) { submission.current = false; setSubmitting(false) }
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      aria-labelledby="create-room-dialog-title"
      PaperProps={{
        sx: {
          maxWidth: 460,
          width: '100%',
          m: 3,
          borderRadius: '12px',
          bgcolor: colors.paperElevated,
          border: `1px solid ${colors.dividerLight}`,
          boxShadow: '0 8px 32px rgba(25, 27, 26, 0.16)',
        },
      }}
    >
      <form onSubmit={handleSubmit} noValidate>
        <DialogTitle
          id="create-room-dialog-title"
          sx={{
            fontFamily: '"Bricolage Grotesque", sans-serif',
            fontSize: '22px',
            fontWeight: 700,
            color: colors.ink,
            pt: 6,
            px: 6,
            pb: 2,
          }}
        >
          Create a new room
        </DialogTitle>
        <DialogContent sx={{ px: 6, py: 2 }}>
          <Typography variant="body2" sx={{ color: colors.inkSecondary, mb: 4 }}>
            Rooms organize conversations by topic. Members can read history and chat.
          </Typography>

          {submitError ? (
            <Alert
              severity="error"
              role="alert"
              sx={{
                mb: 4,
                bgcolor: '#FDF2F0',
                color: colors.error,
                border: `1px solid ${colors.error}`,
              }}
            >
              {submitError}
            </Alert>
          ) : null}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <TextField
              id="create-room-name"
              label="Room name"
              required
              fullWidth
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (nameError) setNameError(null)
              }}
              error={Boolean(nameError)}
              helperText={nameError || `${name.trim().length}/80 characters`}
              disabled={submitting}
              slotProps={{
                htmlInput: {
                  maxLength: 90,
                  'aria-required': 'true',
                },
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: colors.paperElevated,
                  '&:focus-visible': {
                    outline: `2px solid ${colors.ink}`,
                    outlineOffset: '2px',
                  },
                },
              }}
            />

            <TextField
              id="create-room-description"
              label="Description (optional)"
              multiline
              rows={3}
              fullWidth
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                if (descError) setDescError(null)
              }}
              error={Boolean(descError)}
              helperText={descError || `${description.length}/500 characters`}
              disabled={submitting}
              slotProps={{
                htmlInput: {
                  maxLength: 550,
                },
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: colors.paperElevated,
                  '&:focus-visible': {
                    outline: `2px solid ${colors.ink}`,
                    outlineOffset: '2px',
                  },
                },
              }}
            />
          </Box>
        </DialogContent>

        <DialogActions sx={{ px: 6, pb: 6, pt: 3, gap: 2 }}>
          <Button
            type="button"
            variant="outlined"
            onClick={handleClose}
            disabled={submitting}
            sx={{
              minHeight: 44,
              minWidth: 96,
              color: colors.ink,
              borderColor: colors.inputBorder,
              '&:hover': {
                borderColor: colors.ink,
                bgcolor: 'rgba(37, 42, 39, 0.04)',
              },
              '&:focus-visible': {
                outline: `2px solid ${colors.ink}`,
                outlineOffset: '2px',
              },
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={submitting}
            sx={{
              minHeight: 44,
              minWidth: 120,
              bgcolor: colors.ink,
              color: colors.paperElevated,
              '&:hover': {
                bgcolor: '#343B37',
              },
              '&:focus-visible': {
                outline: `2px solid ${colors.ink}`,
                outlineOffset: '2px',
              },
            }}
          >
            {submitting ? 'Creating…' : 'Create room'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
