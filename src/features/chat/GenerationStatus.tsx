import { useSyncExternalStore } from 'react'
import type { Generation } from '@threadline/shared'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import RefreshIcon from '@mui/icons-material/Refresh'
import { colors } from '../../app/theme'

function subscribeConnectivity(notify: () => void) {
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}

const isOfflineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false

export interface GenerationStatusProps {
  readonly generation: Generation | null
  readonly onRetryAi: () => Promise<void>
}

export function GenerationStatus({ generation, onRetryAi }: GenerationStatusProps) {
  const isOffline = useSyncExternalStore(subscribeConnectivity, isOfflineNow, () => false)
  if (!generation) {
    return null
  }


  if (generation.state === 'pending') {
    if (isOffline) {
      return (
        <Box
          role="status"
          aria-live="polite"
          sx={{
            mb: 3,
            p: 2,
            borderRadius: '8px',
            bgcolor: 'rgba(244, 181, 139, 0.12)',
            border: `1px dashed ${colors.apricot}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
            maxWidth: '100%',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ErrorOutlineIcon sx={{ fontSize: 16, color: colors.inkSecondary }} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: colors.ink,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
              }}
            >
              Threadline reply status is uncertain (offline)
            </Typography>
          </Box>

          <Typography variant="body2" sx={{ color: colors.inkSecondary, fontSize: '0.85rem' }}>
            Preparing answer for {generation.requesterLabel}
          </Typography>

          <Typography
            variant="caption"
            sx={{
              color: colors.inkSecondary,
              fontStyle: 'italic',
              fontSize: '0.78rem',
              borderTop: '1px solid rgba(0, 0, 0, 0.06)',
              pt: 0.5,
            }}
          >
            Connection lost while waiting for Threadline. Reconnect to check whether the answer was saved.
          </Typography>
        </Box>
      )
    }

    return (
      <Box
        role="status"
        aria-live="polite"
        sx={{
          mb: 3,
          p: 2,
          borderRadius: '8px',
          bgcolor: 'rgba(244, 181, 139, 0.12)',
          border: `1px dashed ${colors.apricot}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
          maxWidth: '100%',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress
            size={16}
            sx={{
              color: colors.apricot,
              '@media (prefers-reduced-motion: reduce)': {
                animationDuration: '0s',
              },
            }}
          />
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              color: colors.ink,
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
            }}
          >
            <Box
              component="span"
              sx={{
                width: 18,
                height: 18,
                borderRadius: '3px',
                bgcolor: colors.graphite,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                p: '1.5px',
                flexShrink: 0,
              }}
            >
              <Box
                component="img"
                src="/assets/brand/threadline-mark.svg"
                alt=""
                aria-hidden="true"
                sx={{ width: 14, height: 14, display: 'block' }}
              />
            </Box>
            Threadline is thinking…
          </Typography>
        </Box>

        <Typography variant="body2" sx={{ color: colors.inkSecondary, fontSize: '0.85rem' }}>
          Preparing answer for {generation.requesterLabel}
        </Typography>

        <Typography
          variant="caption"
          sx={{
            color: colors.inkSecondary,
            fontStyle: 'italic',
            fontSize: '0.78rem',
            borderTop: `1px solid rgba(0, 0, 0, 0.06)`,
            pt: 0.5,
          }}
        >
          {generation.simulated ? 'Simulated preview · No live AI provider is connected.' : 'The accepted question is saved. This status comes from the room; no answer is displayed before it is saved.'}
        </Typography>
      </Box>
    )
  }

  const isBusy = Boolean(generation.retryPending)
  const ineligibleReason =
    generation.retryIneligibleReason ??
    (generation.canRetry ? null : 'This question is not eligible to be retried.')
  const displayError = generation.canRetry ? generation.retryError : ineligibleReason

  return (
    <Box
      role="alert"
      sx={{
        mb: 3,
        p: 2,
        borderRadius: '8px',
        bgcolor: '#FDF2F0',
        border: `1px solid ${colors.error}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        maxWidth: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ErrorOutlineIcon sx={{ fontSize: 18, color: colors.error }} />
        <Typography variant="body2" sx={{ fontWeight: 600, color: colors.error }}>
          Threadline could not generate a reply.
        </Typography>
      </Box>

      <Typography variant="caption" sx={{ color: colors.inkSecondary, fontSize: '0.8rem' }}>
        {generation.simulated ? 'Simulated preview failure. You can retry generating a sample response.' : 'The saved question remains in the conversation. AI could not finish, or its status needs reconfirming after reconnect.'}
      </Typography>

      {displayError && (
        <Typography variant="body2" sx={{ color: colors.error, fontSize: '0.8125rem', fontWeight: 500 }}>
          {displayError}
        </Typography>
      )}

      {generation.canRetry && (
        <Button
          variant="contained"
          size="small"
          disabled={isBusy}
          startIcon={
            isBusy ? (
              <CircularProgress
                size={16}
                sx={{
                  color: colors.paperElevated,
                  '@media (prefers-reduced-motion: reduce)': {
                    animationDuration: '0s',
                  },
                }}
              />
            ) : (
              <RefreshIcon sx={{ fontSize: 16 }} />
            )
          }
          onClick={() => { if (!isBusy) void onRetryAi() }}
          sx={{
            alignSelf: 'flex-start',
            bgcolor: colors.ink,
            color: colors.paperElevated,
            borderRadius: '6px',
            textTransform: 'none',
            fontSize: '0.8125rem',
            minHeight: 44,
            minWidth: 44,
            px: 2,
            '&:hover': {
              bgcolor: colors.darkRaised,
            },
            '&.Mui-disabled': {
              bgcolor: 'rgba(0, 0, 0, 0.26)',
              color: 'rgba(255, 255, 255, 0.7)',
            },
          }}
        >
          {isBusy ? 'Retrying AI Generation…' : 'Retry AI Generation'}
        </Button>
      )}
    </Box>
  )
}
