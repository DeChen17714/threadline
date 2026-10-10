import type { KeyboardEvent } from 'react'
import type { MessageIntent } from '@threadline/shared'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  TextField,
  Typography,
} from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import RefreshIcon from '@mui/icons-material/Refresh'
import SendIcon from '@mui/icons-material/Send'
import { colors } from '../../app/theme'

export interface ComposerProps {
  readonly draft: string
  readonly onDraftChange: (text: string) => void
  readonly onSend: (intent: MessageIntent) => Promise<void>
  readonly pending: boolean
  readonly pendingIntent?: MessageIntent | null
  readonly error: string | null
  readonly onRetry: () => Promise<void>
  readonly canRetry?: boolean
  readonly isAiBusy: boolean
  readonly askAiAvailable: boolean
  readonly memberCount: number
  readonly offline: boolean
  readonly failedText: string | null
  readonly isMaintenanceActive?: boolean
}

export function Composer({
  draft,
  onDraftChange,
  onSend,
  pending,
  pendingIntent,
  error,
  onRetry,
  canRetry = false,
  isAiBusy,
  askAiAvailable,
  memberCount,
  offline,
  failedText,
  isMaintenanceActive = false,
}: ComposerProps) {
  const isDraftEmpty = draft.trim().length === 0
  const soloAi = askAiAvailable && memberCount === 1
  const isRoomChecking = pending && (pendingIntent === 'room' || (!pendingIntent && !soloAi))
  const isAskChecking = pending && (pendingIntent === 'ask-ai' || (!pendingIntent && soloAi))

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ignore active IME composition
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isDraftEmpty || pending || canRetry || offline || isMaintenanceActive) {
        return
      }
      if (soloAi && isAiBusy) return
      void onSend(soloAi ? 'ask-ai' : 'room')
    }
  }

  return (
    <Box
      component="footer"
      sx={{
        borderTop: `1px solid ${colors.dividerLight}`,
        bgcolor: colors.paperElevated,
        p: { xs: 1.5, sm: 2 },
        pb: { xs: 'max(12px, env(safe-area-inset-bottom, 12px))', sm: 2 },
        position: 'sticky',
        bottom: 0,
        zIndex: 2,
        flexShrink: 0,
      }}
    >
      <Box
        sx={{
          maxWidth: 760,
          mx: 'auto',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
        }}
      >
        {offline && <Alert severity="warning">Offline. Drafts stay on this device until you reconnect; messages are not queued.</Alert>}
        {!askAiAvailable && <Typography variant="caption" sx={{ color: colors.inkSecondary }}>Ask Threadline is not enabled yet. Send to room does not call AI.</Typography>}
        {error && (
          <Alert
            severity="error"
            action={
              canRetry ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void onRetry()}
                  disabled={pending || offline}
                  startIcon={<RefreshIcon sx={{ fontSize: 16 }} />}
                  sx={{
                    fontWeight: 600,
                    textTransform: 'none',
                    minHeight: 44,
                    minWidth: 44,
                    px: 2,
                  }}
                >
                  Retry
                </Button>
              ) : undefined
            }
            sx={{
              bgcolor: '#FDF2F0',
              color: colors.error,
              borderRadius: '8px',
              border: `1px solid ${colors.error}`,
              '& .MuiAlert-icon': { color: colors.error },
              alignItems: 'center',
              py: 0.5,
            }}
          >
            {error}
          </Alert>
        )}
        {failedText && <Box sx={{ border: '1px solid #986000', borderRadius: 2, p: 1.5, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><Typography variant="caption">Unconfirmed send · Retry checks the same message, not a new copy.</Typography><Typography variant="body2">{failedText}</Typography></Box>}

        <TextField
          multiline
          minRows={2}
          maxRows={6}
          autoFocus={false}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={soloAi ? 'Ask Threadline… (Enter to ask, Shift+Enter for newline)' : 'Type a message… (Enter to send to room, Shift+Enter for newline)'}
          inputProps={{
            'aria-label': 'Message draft',
          }}
          sx={{
            bgcolor: colors.paperElevated,
            borderRadius: '12px',
            '& .MuiOutlinedInput-root': {
              borderRadius: '12px',
              color: colors.ink,
              p: 1.5,
              fontSize: '0.9375rem',
              lineHeight: 1.5,
              '& fieldset': {
                borderColor: colors.inputBorder,
              },
              '&:hover fieldset': {
                borderColor: colors.ink,
              },
              '&.Mui-focused fieldset': {
                borderColor: colors.ink,
                borderWidth: '2px',
              },
            },
          }}
        />

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 1.5,
          }}
        >
          <Box sx={{ flex: '1 1 auto', minWidth: 200 }}>
            {isMaintenanceActive ? (
              <Typography
                variant="caption"
                sx={{
                  color: colors.inkSecondary,
                  fontStyle: 'italic',
                  display: 'block',
                }}
              >
                Updating conversation context · Sends and edits paused; keep your draft.
              </Typography>
            ) : isAiBusy ? (
              <Typography
                variant="caption"
                sx={{
                  color: colors.inkSecondary,
                  fontStyle: 'italic',
                  display: 'block',
                }}
              >
                {soloAi ? 'Threadline is thinking · Keep your next question in the draft.' : 'Threadline is thinking · Ask Threadline paused; room chat remains available.'}
              </Typography>
            ) : (
              <Typography
                variant="caption"
                sx={{
                  color: colors.inkSecondary,
                  display: { xs: 'none', sm: 'block' },
                }}
              >
                {soloAi ? 'Enter asks Threadline · Shift+Enter for new line' : 'Enter sends to room · Shift+Enter for new line'}
              </Typography>
            )}
          </Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              flexWrap: 'wrap',
              justifyContent: { xs: 'stretch', sm: 'flex-end' },
              width: { xs: '100%', sm: 'auto' },
            }}
          >
            {!soloAi && (
            <Button
              variant="contained"
              onClick={() => void onSend('room')}
              disabled={pending || isDraftEmpty || canRetry || offline || isMaintenanceActive}
              title={isMaintenanceActive ? 'Updating conversation context · Sends are paused.' : undefined}
              startIcon={
                isRoomChecking ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <SendIcon sx={{ fontSize: 16 }} />
                )
              }
              sx={{
                flex: { xs: '1 1 auto', sm: 'initial' },
                bgcolor: colors.ink,
                color: colors.paperElevated,
                minHeight: 44,
                px: 2.5,
                borderRadius: '8px',
                fontWeight: 600,
                textTransform: 'none',
                fontSize: '0.875rem',
                '&:hover': {
                  bgcolor: colors.darkRaised,
                },
                '&.Mui-disabled': {
                  bgcolor: 'rgba(37, 42, 39, 0.12)',
                  color: 'rgba(37, 42, 39, 0.38)',
                },
                '&:focus-visible': {
                  outline: `2px solid ${colors.ink}`,
                  outlineOffset: '2px',
                },
              }}
            >
              {isRoomChecking ? 'Checking message…' : 'Send to room'}
            </Button>
            )}

            <Button
              variant="contained"
              onClick={() => void onSend('ask-ai')}
              disabled={pending || isDraftEmpty || isAiBusy || !askAiAvailable || canRetry || offline || isMaintenanceActive}
              startIcon={
                isAskChecking ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <AutoAwesomeIcon sx={{ fontSize: 16 }} />
                )
              }
              aria-label="Ask Threadline"
              title={
                isMaintenanceActive
                  ? 'Updating conversation context · AI requests are paused.'
                  : !askAiAvailable
                    ? 'AI replies are not enabled yet.'
                    : isAiBusy
                      ? 'Threadline is already thinking in this room. You can continue sending messages to the room.'
                      : undefined
              }
              sx={{
                flex: { xs: '1 1 auto', sm: 'initial' },
                bgcolor: colors.apricot,
                color: colors.ink,
                minHeight: 44,
                px: 2.5,
                borderRadius: '8px',
                fontWeight: 600,
                textTransform: 'none',
                fontSize: '0.875rem',
                '&:hover': {
                  bgcolor: colors.apricotHover,
                },
                '&.Mui-disabled': {
                  bgcolor: 'rgba(244, 181, 139, 0.35)',
                  color: 'rgba(37, 42, 39, 0.38)',
                },
                '&:focus-visible': {
                  outline: `2px solid ${colors.ink}`,
                  outlineOffset: '2px',
                },
              }}
            >
              {isAskChecking ? 'Checking message…' : 'Ask Threadline'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
