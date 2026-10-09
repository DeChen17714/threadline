import type { Room } from '@threadline/shared'
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material'
import GroupIcon from '@mui/icons-material/Group'
import PersonAddIcon from '@mui/icons-material/PersonAdd'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import { colors } from '../../app/theme'

export interface RoomHeaderProps {
  readonly room: Room
  readonly onInvite?: () => void
  readonly onDelete?: () => void
}

export function RoomHeader({ room, onInvite, onDelete }: RoomHeaderProps) {
  const memberListLabel = room.members.map((m) => m.label).join(', ')

  return (
    <Box
      component="header"
      sx={{
        px: { xs: 2, sm: 3 },
        py: 1.5,
        bgcolor: colors.paperElevated,
        borderBottom: `1px solid ${colors.dividerLight}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 1.5,
      }}
    >
      <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
        <Typography
          variant="h6"
          component="h1"
          sx={{
            fontWeight: 700,
            fontSize: { xs: '1.05rem', sm: '1.2rem' },
            color: colors.ink,
            lineHeight: 1.25,
            wordBreak: 'break-word',
          }}
        >
          {room.name}
        </Typography>
        {room.description.trim().length > 0 && (
          <Typography
            variant="body2"
            sx={{
              color: colors.inkSecondary,
              mt: 0.25,
              fontSize: '0.85rem',
              lineHeight: 1.4,
              wordBreak: 'break-word',
            }}
          >
            {room.description}
          </Typography>
        )}
      </Box>

      <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1.5 }}>
        {onInvite && (
          <Button
            variant="outlined"
            size="small"
            onClick={onInvite}
            startIcon={<PersonAddIcon sx={{ fontSize: 18 }} />}
            aria-label={`Invite members to ${room.name}`}
            sx={{
              borderColor: colors.dividerLight,
              color: colors.ink,
              bgcolor: 'transparent',
              fontSize: '0.825rem',
              fontWeight: 600,
              minHeight: 44,
              px: 1.5,
              textTransform: 'none',
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
            Invite
          </Button>
        )}
        {onDelete && (
          <Button
            variant="outlined"
            size="small"
            color="error"
            onClick={onDelete}
            startIcon={<DeleteOutlineIcon sx={{ fontSize: 18 }} />}
            aria-label={`Delete room ${room.name}`}
            sx={{
              borderColor: colors.dividerLight,
              color: colors.error,
              bgcolor: 'transparent',
              fontSize: '0.825rem',
              fontWeight: 600,
              minHeight: 44,
              px: 1.5,
              textTransform: 'none',
              '&:hover': {
                borderColor: colors.error,
                bgcolor: 'rgba(181, 59, 43, 0.06)',
              },
              '&:focus-visible': {
                outline: `2px solid ${colors.error}`,
                outlineOffset: '2px',
              },
            }}
          >
            Delete
          </Button>
        )}
        <Tooltip title={`Members: ${memberListLabel}`} arrow placement="bottom-end">
          <Chip
            icon={<GroupIcon sx={{ fontSize: 16, color: `${colors.inkSecondary} !important` }} />}
            label={`${room.members.length} ${room.members.length === 1 ? 'member' : 'members'}`}
            size="small"
            variant="outlined"
            tabIndex={0}
            aria-label={`Room members: ${memberListLabel}`}
            sx={{
              borderColor: colors.dividerLight,
              color: colors.inkSecondary,
              bgcolor: 'transparent',
              fontSize: '0.8rem',
              fontWeight: 500,
              minHeight: 44,
              '&:focus-visible': {
                outline: `2px solid ${colors.ink}`,
                outlineOffset: '2px',
              },
            }}
          />
        </Tooltip>
      </Box>
    </Box>
  )
}
