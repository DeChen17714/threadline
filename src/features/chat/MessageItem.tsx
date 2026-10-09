import { useState } from 'react'
import type { HumanMessage, Message } from '@threadline/shared'
import { Box, Button, Chip, IconButton, Menu, MenuItem, Typography } from '@mui/material'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import MoreHorizIcon from '@mui/icons-material/MoreHoriz'
import { MarkdownRenderer } from './MarkdownRenderer'
import { colors } from '../../app/theme'

export interface MessageItemProps {
  readonly message: Message
  readonly currentMemberUid: string
  readonly onScrollToPrompt: (promptId: string) => void
  readonly isHighlighted: boolean
  readonly onEdit?: (message: HumanMessage) => void
  readonly onDelete?: (message: HumanMessage) => void
  readonly isAiBusy?: boolean
  readonly isMaintenanceActive?: boolean
}

function formatTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
export function MessageItem({
  message,
  currentMemberUid,
  onScrollToPrompt,
  isHighlighted,
  onEdit,
  onDelete,
  isAiBusy = false,
  isMaintenanceActive = false,
}: MessageItemProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const formattedTime = formatTimestamp(message.createdAt)

  if (message.kind === 'human') {
    const isCurrentUser = message.authorId === currentMemberUid
    const canEdit = isCurrentUser && !message.deletedAt && Boolean(onEdit)
    const canDelete = isCurrentUser && !message.deletedAt && Boolean(onDelete)
    const showMenu = canEdit || canDelete
    const trimmedLabel = message.authorLabel.trim()
    const namePart = trimmedLabel.split('@')[0] ?? trimmedLabel
    const labelParts = namePart.split(/[\s._-]+/).filter(Boolean)
    const authorInitials = !trimmedLabel
      ? '?'
      : labelParts.length >= 2
        ? `${labelParts[0][0]}${labelParts[1][0]}`.toUpperCase()
        : namePart.slice(0, 2).toUpperCase()
    return (
      <Box
        id={`message-${message.id}`}
        data-message-id={message.id}
        data-message-seq={message.seq}
        tabIndex={-1}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: isCurrentUser ? 'flex-end' : 'flex-start',
          alignSelf: isCurrentUser ? 'flex-end' : 'flex-start',
          maxWidth: { xs: '92%', sm: '82%' },
          minWidth: 0,
          mb: 2.5,
          outline: isHighlighted ? `2px solid ${colors.ink}` : 'none',
          outlineOffset: '4px',
          borderRadius: '8px',
          transition: 'outline 0.25s ease',
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none',
          },
          '&:focus': {
            outline: `2px solid ${colors.ink}`,
            outlineOffset: '4px',
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mb: 0.5,
            flexWrap: 'wrap',
            justifyContent: isCurrentUser ? 'flex-end' : 'flex-start',
          }}
        >
          {!isCurrentUser && (
            <Box
              aria-hidden="true"
              sx={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                bgcolor: colors.graphite,
                color: colors.paperElevated,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.65rem',
                fontWeight: 700,
                flexShrink: 0,
                userSelect: 'none',
                lineHeight: 1,
              }}
            >
              {authorInitials}
            </Box>
          )}

          {isCurrentUser ? (
            <Typography
              variant="caption"
              component="span"
              title={message.authorLabel}
              aria-label={`You (${message.authorLabel})`}
              sx={{
                fontWeight: 600,
                color: colors.inkSecondary,
                fontSize: '0.78rem',
              }}
            >
              You
            </Typography>
          ) : (
            <Typography
              variant="caption"
              component="span"
              title={message.authorLabel}
              aria-label={message.authorLabel}
              sx={{
                fontWeight: 600,
                color: colors.ink,
                fontSize: '0.78rem',
                maxWidth: { xs: 140, sm: 220 },
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-block',
                verticalAlign: 'bottom',
              }}
            >
              {message.authorLabel}
            </Typography>
          )}

          {message.intent === 'ask-ai' && (
            <Chip
              label="Asked Threadline"
              size="small"
              icon={<AutoAwesomeIcon sx={{ fontSize: '13px !important', color: `${colors.ink} !important` }} />}
              sx={{
                height: 20,
                fontSize: '0.72rem',
                fontWeight: 600,
                bgcolor: colors.apricot,
                color: colors.ink,
                border: 'none',
                '& .MuiChip-label': { px: 0.75 },
              }}
            />
          )}

          {formattedTime && (
            <Typography
              variant="caption"
              sx={{
                color: colors.inkSecondary,
                fontSize: '0.75rem',
              }}
            >
              {formattedTime}
            </Typography>
          )}
          {Boolean(message.editedAt && !message.deletedAt) && (
            <Typography
              variant="caption"
              sx={{
                color: colors.inkSecondary,
                fontSize: '0.75rem',
                fontStyle: 'italic',
              }}
            >
              Edited
            </Typography>
          )}
          {showMenu && (
            <>
              <IconButton
                size="small"
                aria-label={`Message options for message ${message.seq}`}
                aria-controls={anchorEl ? `message-menu-${message.id}` : undefined}
                aria-haspopup="true"
                aria-expanded={Boolean(anchorEl)}
                onClick={(e) => setAnchorEl(e.currentTarget)}
                sx={{
                  p: 0.25,
                  minWidth: 44,
                  minHeight: 44,
                  ml: 0.5,
                  color: colors.inkSecondary,
                  '&:hover': { color: colors.ink, bgcolor: 'rgba(0, 0, 0, 0.04)' },
                }}
              >
                <MoreHorizIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <Menu
                id={`message-menu-${message.id}`}
                anchorEl={anchorEl}
                open={Boolean(anchorEl)}
                onClose={() => setAnchorEl(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <MenuItem
                  onClick={() => {
                    setAnchorEl(null)
                    onEdit?.(message)
                  }}
                  disabled={isAiBusy || isMaintenanceActive}
                  title={
                    isAiBusy
                       ? 'Threadline is thinking · Message edits paused'
                       : isMaintenanceActive
                         ? 'Updating conversation context · Message edits paused'
                         : undefined
                   }
                   sx={{ minHeight: 44, px: 2, fontSize: '0.875rem' }}
                 >
                   Edit message
                 </MenuItem>
                 {canDelete && (
                   <MenuItem
                     onClick={() => {
                       setAnchorEl(null)
                       onDelete?.(message)
                     }}
                     disabled={isAiBusy || isMaintenanceActive}
                     title={
                       isAiBusy
                         ? 'Threadline is thinking · Message deletion paused'
                         : isMaintenanceActive
                           ? 'Updating conversation context · Message deletion paused'
                           : undefined
                     }
                     sx={{ minHeight: 44, px: 2, fontSize: '0.875rem', color: colors.error }}
                   >
                     Delete
                   </MenuItem>
                 )}
               </Menu>
             </>
           )}
         </Box>

         <Box
           sx={{
             maxWidth: '100%',
             minWidth: 0,
             bgcolor: isCurrentUser ? colors.humanBubble : colors.paperElevated,
             color: colors.ink,
             borderRadius: '8px',
             border: isCurrentUser ? 'none' : `1px solid ${colors.dividerLight}`,
             px: 2,
             py: 1.25,
             boxShadow: isCurrentUser
               ? '0 1px 2px rgba(0, 0, 0, 0.04)'
               : '0 1px 3px rgba(0, 0, 0, 0.04)',
             wordBreak: 'break-word',
           }}
         >
           {message.deletedAt ? (
             <Typography
               sx={{
                 fontStyle: 'italic',
                 color: colors.inkSecondary,
                 fontSize: '0.9rem',
               }}
             >
               Message deleted
             </Typography>
           ) : (
             <MarkdownRenderer content={message.text} />
           )}
         </Box>
       </Box>
     )
   }

  return (
    <Box
      id={`message-${message.id}`}
      data-message-id={message.id}
      data-message-seq={message.seq}
      tabIndex={-1}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        alignSelf: 'flex-start',
        width: '100%',
        minWidth: 0,
        mb: 3,
        outline: isHighlighted ? `2px solid ${colors.ink}` : 'none',
        outlineOffset: '4px',
        borderRadius: '8px',
        transition: 'outline 0.25s ease',
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
        },
        '&:focus': {
          outline: `2px solid ${colors.ink}`,
          outlineOffset: '4px',
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 1,
          flexWrap: 'wrap',
          width: '100%',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box
            sx={{
              width: 22,
              height: 22,
              borderRadius: '4px',
              bgcolor: colors.graphite,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              p: '2px',
              flexShrink: 0,
            }}
          >
            <Box
              component="img"
              src="/assets/brand/threadline-mark.svg"
              alt=""
              aria-hidden="true"
              sx={{ width: 18, height: 18, display: 'block' }}
            />
          </Box>
          <Typography
            component="span"
            sx={{
              fontFamily: '"Bricolage Grotesque", sans-serif',
              fontWeight: 700,
              color: colors.ink,
              fontSize: '0.95rem',
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
            }}
          >
            Threadline
          </Typography>
        </Box>

        {message.simulated && (
          <Chip
            label="Simulated preview"
            size="small"
            variant="outlined"
            sx={{
              height: 20,
              fontSize: '0.72rem',
              borderColor: colors.dividerLight,
              color: colors.inkSecondary,
              bgcolor: 'transparent',
              '& .MuiChip-label': { px: 0.75 },
            }}
          />
        )}

        {message.contextState === 'stale' && (
          <Chip
            label={
              message.contextReason === 'earlier-version'
                ? 'Reply to earlier version'
                : message.contextReason === 'deleted-message'
                  ? 'Reply to deleted message'
                  : 'Earlier context changed'
            }
            size="small"
            variant="outlined"
            sx={{
              height: 20,
              fontSize: '0.72rem',
              borderColor: colors.dividerLight,
              color: colors.inkSecondary,
              bgcolor: 'transparent',
              fontWeight: 500,
              '& .MuiChip-label': { px: 0.75 },
            }}
          />
        )}

        <Button
          size="small"
          variant="text"
          onClick={() => onScrollToPrompt(message.replyToId)}
          startIcon={<ArrowUpwardIcon sx={{ fontSize: 13, flexShrink: 0 }} />}
          aria-label={`Jump to prompt by ${message.requesterLabel}`}
          title={`Jump to prompt by ${message.requesterLabel}`}
          sx={{
            minHeight: 44,
            minWidth: 44,
            px: 1,
            py: 0.5,
            fontSize: '0.78rem',
            color: colors.inkSecondary,
            textTransform: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            maxWidth: { xs: 170, sm: 240 },
            '&:hover': {
              color: colors.ink,
              textDecoration: 'underline',
              bgcolor: 'rgba(0, 0, 0, 0.04)',
            },
            '&:focus-visible': {
              outline: `2px solid ${colors.ink}`,
              outlineOffset: '2px',
            },
          }}
        >
          <Box
            component="span"
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'inline-block',
            }}
          >
            Prompt by {message.requesterLabel}
          </Box>
        </Button>

        <Box sx={{ ml: { xs: 0, sm: 'auto' }, display: 'flex', alignItems: 'center', gap: 1 }}>
          {Boolean(message.editedAt && !message.deletedAt) && (
            <Typography
              variant="caption"
              sx={{
                color: colors.inkSecondary,
                fontSize: '0.75rem',
                fontStyle: 'italic',
              }}
            >
              Edited
            </Typography>
          )}
          {formattedTime && (
            <Typography
              variant="caption"
              sx={{
                color: colors.inkSecondary,
                fontSize: '0.75rem',
              }}
            >
              {formattedTime}
            </Typography>
          )}
        </Box>
      </Box>

      <Box
        sx={{
          width: '100%',
          height: '1px',
          bgcolor: colors.dividerLight,
          mb: 1.5,
        }}
      />

      <Box
        sx={{
          bgcolor: 'transparent',
          color: colors.ink,
          width: '100%',
          minWidth: 0,
          wordBreak: 'break-word',
          borderLeft: `2px solid ${colors.apricot}`,
          pl: { xs: 1.5, sm: 2 },
          py: 0.25,
        }}
      >
        {message.deletedAt ? (
          <Typography
            sx={{
              fontStyle: 'italic',
              color: colors.inkSecondary,
              fontSize: '0.9rem',
            }}
          >
            Message deleted
          </Typography>
        ) : (
          <MarkdownRenderer content={message.text} />
        )}
      </Box>
    </Box>
  )
}
