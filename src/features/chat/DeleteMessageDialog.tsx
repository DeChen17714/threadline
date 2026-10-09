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
import type { HumanMessage } from '@threadline/shared'
import { colors } from '../../app/theme'
import { CommandUncertainError } from '../../services/workspace'

export interface DeleteMessageDialogProps {
  readonly open: boolean
  readonly message: HumanMessage | null
  readonly onClose: (deletedMessageId?: string) => void
  readonly onDelete: (
    messageId: string,
    expectedVersion: number,
    requestId: string,
  ) => Promise<void>
  readonly isAiBusy?: boolean
  readonly isMaintenanceActive?: boolean
  readonly initialRequestId?: string
  readonly initialError?: string | null
  readonly initialExpectedVersion?: number
  readonly initialUncertain?: boolean
  readonly onDismissState?: (messageId: string) => void
}

export function DeleteMessageDialog({
  open,
  message,
  onClose,
  onDelete,
  isAiBusy = false,
  isMaintenanceActive = false,
  initialRequestId,
  initialError = null,
  initialExpectedVersion,
  initialUncertain = false,
  onDismissState,
}: DeleteMessageDialogProps) {
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
  const targetVersion = targetMessage.version
  const targetDeleted = Boolean(targetMessage.deletedAt)

  function handleClose() {
    if (activeSubmission.current) return
    if (!uncertain) {
      onDismissState?.(targetMessageId)
    }
    onClose()
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    if (activeSubmission.current || isAiBusy || isMaintenanceActive) return

    if (targetDeleted) {
      setError('This message has already been deleted.')
      return
    }

    if (!uncertain && targetVersion !== expectedVersion) {
      setError(`Message was modified elsewhere (current version is ${targetVersion}). Please review before deleting.`)
      return
    }

    activeSubmission.current = true
    setSubmitting(true)
    setError(null)

    try {
      await onDelete(targetMessageId, expectedVersion, requestId)
      if (lifetime.current.active) {
        activeSubmission.current = false
        setSubmitting(false)
        onClose(targetMessageId)
      }
    } catch (err) {
      if (lifetime.current.active) {
        activeSubmission.current = false
        setSubmitting(false)
        const isUncertain = err instanceof CommandUncertainError
        setUncertain(isUncertain)
        setError(
          err instanceof Error
            ? err.message
            : 'Message could not be deleted.',
        )
      }
    }
  }

  const isBlocked = isAiBusy || isMaintenanceActive || submitting || Boolean(targetMessage.deletedAt) || (!uncertain && targetMessage.version !== expectedVersion)

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-labelledby="delete-message-dialog-title"
      aria-describedby="delete-message-dialog-description"
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
      <form onSubmit={handleConfirm}>
        <DialogTitle
          id="delete-message-dialog-title"
          sx={{
            fontWeight: 700,
            fontSize: '1.125rem',
            color: colors.ink,
            pb: 1,
          }}
        >
          Delete message
        </DialogTitle>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
          <Typography id="delete-message-dialog-description" variant="body2" sx={{ color: colors.ink }}>
            Are you sure you want to delete this message? Its text will be removed for all members, and dependent AI replies will be marked.
          </Typography>

          <Box
            sx={{
              p: 1.5,
              bgcolor: 'rgba(0, 0, 0, 0.03)',
              borderRadius: '8px',
              border: `1px solid ${colors.dividerLight}`,
              maxHeight: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <Typography variant="caption" sx={{ color: colors.inkSecondary, display: 'block', mb: 0.5, fontWeight: 600 }}>
              Message #{targetMessage.seq} (saved version {expectedVersion})
            </Typography>
            <Typography variant="body2" sx={{ color: colors.ink, fontStyle: 'italic', wordBreak: 'break-word' }}>
              &ldquo;{targetMessage.text.slice(0, 160)}{targetMessage.text.length > 160 ? '…' : ''}&rdquo;
            </Typography>
          </Box>

          {uncertain && (
            <Alert severity="warning">
              Deletion status is uncertain. Confirm whether the deletion was processed before attempting again.
            </Alert>
          )}

          {!uncertain && !submitting && targetMessage.version !== expectedVersion && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Alert severity="warning">
                Message was modified elsewhere (current version is {targetMessage.version}).
              </Alert>
              <Button
                size="small"
                variant="outlined"
                onClick={() => {
                  const nextVersion = targetMessage.version ?? 1
                  const nextRequestId = crypto.randomUUID()
                  setExpectedVersion(nextVersion)
                  setRequestId(nextRequestId)
                  setError(null)
                }}
                sx={{ minHeight: 44, textTransform: 'none', fontWeight: 600, color: colors.ink, borderColor: colors.inputBorder }}
              >
                Acknowledge current version {targetMessage.version} to delete
              </Button>
            </Box>
          )}

          {targetMessage.deletedAt && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              This message has already been deleted.
            </Alert>
          )}

          {isAiBusy && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Threadline is thinking · Message deletion is paused until the reply finishes.
            </Alert>
          )}

          {isMaintenanceActive && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Updating conversation context · Message deletions are paused.
            </Alert>
          )}

          {error && (
            <Alert severity="error" sx={{ py: 0.5 }}>
              {error}
            </Alert>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2, pt: 1, gap: 1 }}>
          <Button
            onClick={handleClose}
            disabled={submitting}
            autoFocus
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
            color="error"
            disabled={isBlocked}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{
              minHeight: 44,
              minWidth: 80,
              bgcolor: colors.error,
              color: '#FFFFFF',
              textTransform: 'none',
              fontWeight: 600,
              borderRadius: '8px',
              '&:hover': { bgcolor: '#B3261E' },
              '&.Mui-disabled': {
                bgcolor: 'rgba(37, 42, 39, 0.12)',
                color: 'rgba(37, 42, 39, 0.38)',
              },
            }}
          >
            {submitting ? 'Deleting…' : uncertain ? 'Confirm deletion' : 'Delete'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
