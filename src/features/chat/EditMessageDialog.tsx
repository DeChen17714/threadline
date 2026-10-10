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
  TextField,
  Typography,
} from '@mui/material'
import type { HumanMessage } from '@threadline/shared'
import { colors } from '../../app/theme'
import { CommandUncertainError } from '../../services/workspace'

export interface EditMessageDialogProps {
  readonly open: boolean
  readonly message: HumanMessage | null
  readonly onClose: () => void
  readonly onSave: (
    messageId: string,
    expectedVersion: number,
    newText: string,
    requestId: string,
  ) => Promise<void>
  readonly isAiBusy?: boolean
  readonly isMaintenanceActive?: boolean
  readonly initialDraft?: string
  readonly initialRequestId?: string
  readonly initialError?: string | null
  readonly initialExpectedVersion?: number
  readonly initialUncertain?: boolean
  readonly onDraftChange?: (messageId: string, draft: string, requestId: string, expectedVersion: number) => void
}

export function EditMessageDialog({
  open,
  message,
  onClose,
  onSave,
  isAiBusy = false,
  isMaintenanceActive = false,
  initialDraft,
  initialRequestId,
  initialError = null,
  initialExpectedVersion,
  initialUncertain = false,
  onDraftChange,
}: EditMessageDialogProps) {
  const [text, setText] = useState(() => initialDraft ?? message?.text ?? '')
  const [error, setError] = useState<string | null>(initialError)
  const [submitting, setSubmitting] = useState(false)
  const [uncertain, setUncertain] = useState(initialUncertain)
  const [requestId, setRequestId] = useState(() => initialRequestId ?? crypto.randomUUID())
  const [expectedVersion, setExpectedVersion] = useState(() => initialExpectedVersion ?? message?.version ?? 1)
  const activeSubmission = useRef(false)
  const lifetime = useRef({ active: true })
  useEffect(() => {
    const current = lifetime.current
    current.active = true
    return () => { current.active = false }
  }, [])

  const targetMessage = message
  if (!targetMessage) return null
  const targetMessageId = targetMessage.id

  function handleChange(value: string) {
    if (uncertain || activeSubmission.current || value === text) return
    setText(value)
    const nextRequestId = crypto.randomUUID()
    setRequestId(nextRequestId)
    onDraftChange?.(targetMessageId, value, nextRequestId, expectedVersion)
    setError(null)
  }

  function handleClose() {
    if (activeSubmission.current) return
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (activeSubmission.current || isAiBusy || isMaintenanceActive) return

    const trimmed = text.trim()
    if (!trimmed) {
      setError('Message cannot be empty.')
      return
    }

    if (text.length > 4000) {
      setError('Use at most 4,000 characters. Your draft is retained.')
      return
    }

    const byteLength = new TextEncoder().encode(text).length
    if (byteLength > 16384) {
      setError('Message exceeds 16 KiB limit. Your draft is retained.')
      return
    }

    activeSubmission.current = true
    setSubmitting(true)
    setError(null)

    try {
      await onSave(targetMessageId, expectedVersion, text, requestId)
      if (lifetime.current.active) {
        activeSubmission.current = false
        setSubmitting(false)
        onClose()
      }
    } catch (err) {
      if (lifetime.current.active) {
        activeSubmission.current = false
        setSubmitting(false)
        setUncertain(err instanceof CommandUncertainError)
        setError(
          err instanceof Error
            ? err.message
            : 'Message could not be updated. Your draft is retained.',
        )
      }
    }
  }

  const isBlank = text.trim().length === 0
  const isTooLong = text.length > 4000 || new TextEncoder().encode(text).length > 16384
  const isBlocked = isAiBusy || isMaintenanceActive || submitting || isBlank || isTooLong

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-labelledby="edit-message-dialog-title"
      fullWidth
      maxWidth="xs"
      slotProps={{
        paper: {
          sx: {
            bgcolor: colors.paperElevated,
            borderRadius: '12px',
            p: 1,
          },
        },
      }}
    >
      <form onSubmit={handleSubmit}>
        <DialogTitle
          id="edit-message-dialog-title"
          sx={{
            fontWeight: 700,
            fontSize: '1.125rem',
            color: colors.ink,
            pb: 1,
          }}
        >
          Edit message
        </DialogTitle>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
          <Typography variant="caption" sx={{ color: colors.inkSecondary }}>
            Updating this message will update conversation context and mark dependent replies.
          </Typography>
          <Typography variant="caption">Editing saved version {expectedVersion}</Typography>
          {uncertain && <Alert severity="warning">Confirm whether this edit was saved before changing its text.</Alert>}
          {!uncertain && !submitting && targetMessage.version !== expectedVersion && (
            <Button onClick={() => {
              const nextVersion = targetMessage.version ?? 1
              const nextRequestId = crypto.randomUUID()
              setExpectedVersion(nextVersion)
              setRequestId(nextRequestId)
              onDraftChange?.(targetMessageId, text, nextRequestId, nextVersion)
              setError(null)
            }}>Use current version {targetMessage.version} and keep my draft</Button>
          )}

          {isAiBusy && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Threadline is thinking · Message edits are paused until the reply finishes.
            </Alert>
          )}

          {isMaintenanceActive && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Updating conversation context · Message edits are paused.
            </Alert>
          )}

          {error && (
            <Alert severity="error" sx={{ py: 0.5 }}>
              {error}
            </Alert>
          )}

          <TextField
            multiline
            minRows={3}
            maxRows={8}
            autoFocus
            fullWidth
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            disabled={submitting || uncertain}
            placeholder="Edit your message…"
            inputProps={{
              'aria-label': 'Edit message text',
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: '8px',
                color: colors.ink,
                '& fieldset': { borderColor: colors.inputBorder },
                '&:hover fieldset': { borderColor: colors.ink },
                '&.Mui-focused fieldset': { borderColor: colors.ink, borderWidth: '2px' },
              },
            }}
          />

          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography
              variant="caption"
              sx={{
                color: isTooLong ? colors.error : colors.inkSecondary,
                fontSize: '0.75rem',
              }}
            >
              {text.length} / 4,000 characters
            </Typography>
          </Box>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2, pt: 1, gap: 1 }}>
          <Button
            onClick={handleClose}
            disabled={submitting}
            sx={{
              minHeight: 44,
              minWidth: 44,
              color: colors.inkSecondary,
              textTransform: 'none',
              fontWeight: 600,
              '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.04)', color: colors.ink },
            }}
          >
            Cancel
          </Button>

          <Button
            type="submit"
            variant="contained"
            disabled={isBlocked}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{
              minHeight: 44,
              minWidth: 80,
              bgcolor: colors.ink,
              color: colors.paperElevated,
              textTransform: 'none',
              fontWeight: 600,
              borderRadius: '8px',
              '&:hover': { bgcolor: colors.darkRaised },
              '&.Mui-disabled': {
                bgcolor: 'rgba(37, 42, 39, 0.12)',
                color: 'rgba(37, 42, 39, 0.38)',
              },
            }}
          >
            {submitting ? 'Checking message…' : uncertain ? 'Confirm saved edit' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
