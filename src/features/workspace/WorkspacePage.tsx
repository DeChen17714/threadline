import { useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  Drawer,
  IconButton,
  Snackbar,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import HomeIcon from '@mui/icons-material/Home'
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom'
import MenuIcon from '@mui/icons-material/Menu'
import TagIcon from '@mui/icons-material/Tag'
import type { Room } from '@threadline/shared'
import type { PreviewControls, PreviewScenario, WorkspacePort } from '../../services/workspace'
import type { InvitationPort } from '../../services/invitations'
import type { MaintenancePort } from '../../services/maintenance'
import { colors } from '../../app/theme'
import { ChatPanel } from '../chat/ChatPanel'
import { CreateRoomDialog } from './CreateRoomDialog'
import { InviteDialog } from '../invitations/InviteDialog'
import { DeleteRoomDialog } from './DeleteRoomDialog'
import { MaintenancePanel } from './MaintenancePanel'
import { useWorkspace } from './useWorkspace'
import styles from './WorkspacePage.module.css'
export interface WorkspacePageProps {
  readonly port: WorkspacePort
  readonly preview?: PreviewControls
  readonly roomId: string | null
  readonly onSelectRoom: (id: string) => void
  readonly onHome: () => void
  readonly accountEmail?: string | null
  readonly onSignOut?: () => Promise<void> | void
  readonly invitations?: InvitationPort
  readonly maintenance?: MaintenancePort
}

const SCENARIO_OPTIONS: readonly { readonly value: PreviewScenario; readonly label: string }[] = [
  { value: 'normal', label: 'Normal (seeded rooms)' },
  { value: 'empty', label: 'Empty (no rooms)' },
  { value: 'loading', label: 'Loading state' },
  { value: 'read-error', label: 'Read error (room/chat)' },
  { value: 'send-error', label: 'Send error (message)' },
  { value: 'ai-error', label: 'AI error (generation)' },
  { value: 'create-error', label: 'Create room error' },
]

export function WorkspacePage({
  port,
  preview,
  roomId,
  onSelectRoom,
  onHome,
  accountEmail,
  onSignOut,
  invitations,
  maintenance,
}: WorkspacePageProps) {
  // Preserve single hook instance across room switches to retain per-room drafts
  const workspace = useWorkspace(port, roomId)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null)
  const [inviteRoomId, setInviteRoomId] = useState<string | null>(null)
  const [deletingRoom, setDeletingRoom] = useState<Room | null>(null)
  const [maintenanceRevision, setMaintenanceRevision] = useState(0)
  const readyRooms = workspace.rooms.status === 'ready' ? workspace.rooms.data : null
  const selectedRoomState = workspace.selectedRoom
  const currentRoom = selectedRoomState.status === 'ready' ? selectedRoomState.data : null


  const isCreator = Boolean(
    currentRoom && port.member.uid && currentRoom.creatorId === port.member.uid,
  )
  const canInvite = Boolean(isCreator && invitations && currentRoom)
  const canDelete = Boolean(isCreator && maintenance && currentRoom)
  const activeDeletingRoom =
    deletingRoom && deletingRoom.creatorId === port.member.uid && deletingRoom.id === roomId ? deletingRoom : null
  function handleRoomCreated(room: Room) {
    setCreateDialogOpen(false)
    setMobileDrawerOpen(false)
    setSnackbarMessage(`Room "${room.name}" created.`)
    onSelectRoom(room.id)
  }


  const sidebarContent = (
    <>
      <div className={styles.sidebarHeader}>
        <div className={styles.brandRow}>
          <button
            type="button"
            className={styles.brandButton}
            onClick={onHome}
            aria-label="Return to Threadline introduction"
          >
            Threadline
          </button>
          <Button
            type="button"
            className={styles.homeAction}
            onClick={onHome}
            startIcon={<HomeIcon fontSize="small" />}
            size="small"
            aria-label="Go to home landing page"
          >
            Home
          </Button>
        </div>

        <button
          type="button"
          className={styles.newRoomButton}
          onClick={() => setCreateDialogOpen(true)}
          aria-label="Create a new room"
        >
          <AddIcon fontSize="small" />
          <span>New room</span>
        </button>
      </div>

      <nav className={styles.roomsSection} aria-label="Rooms">
        <div className={styles.roomsHeader}>
          <span>Rooms</span>
          <span>{readyRooms ? readyRooms.length : ''}</span>
        </div>

        {workspace.rooms.status === 'loading' ? (
          <Box sx={{ p: 4, display: 'flex', alignItems: 'center', gap: 2, color: colors.mutedDark }}>
            <CircularProgress size={16} sx={{ color: colors.apricot }} />
            <Typography variant="body2" sx={{ color: colors.mutedDark }}>
              Loading rooms…
            </Typography>
          </Box>
        ) : workspace.rooms.status === 'error' ? (
          <Box sx={{ p: 4, color: '#F4B58B' }}>
            <Typography variant="body2" sx={{ color: '#F4B58B', fontSize: 13, mb: 1 }}>
              {workspace.rooms.message || 'Unable to load rooms'}
            </Typography>
            {workspace.retryRooms && (
              <Button
                variant="outlined"
                size="small"
                onClick={() => workspace.retryRooms?.()}
                sx={{
                  color: '#F4B58B',
                  borderColor: '#F4B58B',
                  minHeight: 44,
                  fontSize: 12,
                  '&:hover': {
                    borderColor: '#F6F3ED',
                    color: '#F6F3ED',
                  },
                }}
              >
                Retry
              </Button>
            )}
          </Box>
        ) : readyRooms && readyRooms.length === 0 ? (
          <div className={styles.emptyRoomsMsg}>
            No rooms yet. Create a room to start a conversation.
          </div>
        ) : readyRooms ? (
          <>
            <ul className={styles.roomList} role="list">
              {readyRooms.map((room) => {
                const isActive = room.id === roomId
                return (
                  <li key={room.id} role="listitem">
                    <button
                      type="button"
                      className={`${styles.roomItem} ${isActive ? styles.roomItemActive : ''}`}
                      onClick={() => {
                        onSelectRoom(room.id)
                        setMobileDrawerOpen(false)
                      }}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span className={styles.roomIcon}>
                        <TagIcon fontSize="small" />
                      </span>
                      <span className={styles.roomName}>{room.name}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {workspace.loadMoreRooms && readyRooms.length >= 25 && (
              <Box sx={{ p: 2 }}>
                <Button
                  fullWidth
                  variant="outlined"
                  size="small"
                  onClick={() => workspace.loadMoreRooms?.()}
                  sx={{
                    color: colors.paper,
                    borderColor: colors.dividerDark,
                    minHeight: 44,
                    fontSize: 12,
                    '&:hover': {
                      borderColor: colors.paper,
                      bgcolor: 'rgba(255, 255, 255, 0.05)',
                    },
                  }}
                >
                  Load more rooms
                </Button>
              </Box>
            )}
          </>
        ) : null}
      </nav>

      <div className={styles.sidebarFooter}>
        <div className={styles.identityBox}>
          <div className={styles.identityAvatar} aria-hidden="true">
            {(port.member.label || accountEmail || 'M').charAt(0).toUpperCase()}
          </div>
          <div className={styles.identityDetails}>
            <span className={styles.identityName}>{port.member.label}</span>
            {accountEmail && accountEmail !== port.member.label ? (
              <span className={styles.identityBadge} style={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {accountEmail}
              </span>
            ) : preview ? (
              <span className={styles.identityBadge}>Fictional identity (preview)</span>
            ) : null}
          </div>
        </div>

        {onSignOut && (
          <Button
            type="button"
            variant="outlined"
            size="small"
            onClick={() => void onSignOut()}
            sx={{
              minHeight: 36,
              color: colors.paper,
              borderColor: colors.dividerDark,
              fontSize: '12px',
              textTransform: 'none',
              '&:hover': {
                borderColor: colors.paper,
                bgcolor: 'rgba(255, 255, 255, 0.05)',
              },
              '&:focus-visible': {
                outline: `2px solid ${colors.apricot}`,
                outlineOffset: '2px',
              },
            }}
          >
            Sign out
          </Button>
        )}

        {preview && (
          <div className={styles.scenarioSelector}>
            <label htmlFor="preview-scenario-select" className={styles.scenarioLabel}>
              Preview State (Demo Showcase)
            </label>
            <select
              id="preview-scenario-select"
              className={styles.scenarioSelect}
              value={preview.scenario}
              onChange={(e) => {
                const next = e.target.value as PreviewScenario
                preview.setScenario(next)
              }}
              aria-label="Select preview state scenario"
            >
              {SCENARIO_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </>
  )

  return (
    <div className={styles.root}>
      {/* Persistent honest preview banner */}
      {preview && (
        <aside
          className={styles.banner}
          role="status"
          aria-label="Local preview notice"
        >
          <span>
            <strong className={styles.bannerHighlight}>Notice:</strong>
            Local preview — fictional accounts, memory-only storage and simulated AI. Reload resets changes.
          </span>
        </aside>
      )}

      {/* 48px Mobile Topbar */}
      <header className={styles.topbar} aria-label="Mobile workspace header">
        <div className={styles.topbarLeft}>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="Open rooms navigation"
            onClick={() => setMobileDrawerOpen(true)}
            sx={{
              minWidth: 44,
              minHeight: 44,
              color: colors.paper,
              '&:focus-visible': {
                outline: `2px solid ${colors.apricot}`,
                outlineOffset: '2px',
              },
            }}
          >
            <MenuIcon />
          </IconButton>
          <span className={styles.topbarTitle}>
            {currentRoom ? currentRoom.name : 'Threadline Workspace'}
          </span>
        </div>

        <div className={styles.topbarActions}>
          <IconButton
            color="inherit"
            aria-label="Create a new room"
            onClick={() => setCreateDialogOpen(true)}
            sx={{
              minWidth: 44,
              minHeight: 44,
              color: colors.paper,
              '&:focus-visible': {
                outline: `2px solid ${colors.apricot}`,
                outlineOffset: '2px',
              },
            }}
          >
            <AddIcon />
          </IconButton>
          <IconButton
            color="inherit"
            aria-label="Go to home landing page"
            onClick={onHome}
            sx={{
              minWidth: 44,
              minHeight: 44,
              color: colors.paper,
              '&:focus-visible': {
                outline: `2px solid ${colors.apricot}`,
                outlineOffset: '2px',
              },
            }}
          >
            <HomeIcon />
          </IconButton>
        </div>
      </header>

      {/* Main Container: 264px desktop sidebar + paper workspace */}
      <div className={styles.bodyContainer}>
        {/* Desktop Sidebar (264px) */}
        <aside className={styles.sidebar} aria-label="Sidebar navigation">
          {sidebarContent}
        </aside>

        {/* Mobile Drawer (280px) */}
        <Drawer
          anchor="left"
          open={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          PaperProps={{
            sx: {
              width: 280,
              bgcolor: colors.graphite,
              color: colors.paper,
              borderRight: `1px solid ${colors.dividerDark}`,
            },
          }}
        >
          {sidebarContent}
        </Drawer>

        {/* Paper Workspace Area */}
        <main className={styles.workspaceArea} id="workspace-main-content">
          {maintenance && (
            <MaintenancePanel
              port={maintenance}
              refreshRevision={maintenanceRevision}
            />
          )}
          {roomId ? (
            selectedRoomState.status === 'loading' ? (
              <div className={styles.centerStateCard} role="status">
                <CircularProgress size={32} sx={{ color: colors.ink, mb: 3 }} />
                <h2 className={styles.stateTitle}>Loading room…</h2>
                <p className={styles.stateBody}>Connecting to room and checking authorization.</p>
              </div>
            ) : selectedRoomState.status === 'error' ? (
              <div className={styles.centerStateCard} role="alert">
                <ErrorOutlineIcon sx={{ fontSize: 44, color: colors.error, mb: 2 }} />
                <h2 className={styles.stateTitle}>Unable to load room</h2>
                <p className={styles.stateBody}>{selectedRoomState.message}</p>
                <Button
                  variant="contained"
                  onClick={() => onSelectRoom('')}
                  sx={{
                    minHeight: 44,
                    bgcolor: colors.ink,
                    color: colors.paperElevated,
                    '&:hover': { bgcolor: '#343B37' },
                  }}
                >
                  Return to workspace
                </Button>
              </div>
            ) : currentRoom ? (
                <div className={styles.chatWrapper}>
                  <ChatPanel
                    key={`${port.member.uid}/${currentRoom.id}`}
                    room={currentRoom}
                    conversation={workspace.conversation}
                    member={port.member}
                    draft={workspace.draft}
                    onDraftChange={workspace.setDraft}
                    pending={workspace.pending}
                    error={workspace.error}
                    onSend={workspace.send}
                    onRetry={workspace.retrySend}
                    onRetryAi={workspace.retryAi}
                    canRetry={workspace.canRetry}
                    askAiAvailable={port.capabilities.askAi}
                    failedText={workspace.failedText}
                    onRetryConversation={workspace.retryConversation}
                    window={workspace.window}
                    onFreezeHistory={workspace.freezeHistory}
                    onLoadOlder={workspace.loadOlder}
                    onJumpToLatest={workspace.jumpToLatest}
                    onInvite={canInvite ? () => setInviteRoomId(currentRoom.id) : undefined}
                    onDelete={canDelete ? () => setDeletingRoom(currentRoom) : undefined}
                    onEditMessage={workspace.editMessage}
                    editDrafts={workspace.editDrafts}
                    onEditDraftChange={workspace.setEditDraft}
                    onDeleteMessage={workspace.deleteMessage}
                    deleteStates={workspace.deleteStates}
                    onDismissDeleteState={workspace.dismissDeleteState}
                    maintenanceWorking={workspace.maintenanceWorking}
                    maintenanceError={workspace.maintenanceError}
                    onResumeMaintenance={workspace.resumeMaintenance}
                  />
                </div>
            ) : (
              <div className={styles.centerStateCard} role="alert">
                <MeetingRoomIcon sx={{ fontSize: 44, color: colors.inkSecondary, mb: 2 }} />
                <h2 className={styles.stateTitle}>Room unavailable</h2>
                <p className={styles.stateBody}>
                  This room does not exist, was deleted, or access was revoked.
                </p>
                <Button
                  variant="contained"
                  onClick={() => onSelectRoom('')}
                  sx={{
                    minHeight: 44,
                    bgcolor: colors.ink,
                    color: colors.paperElevated,
                    '&:hover': { bgcolor: '#343B37' },
                  }}
                >
                  Return to workspace
                </Button>
              </div>
            )
          ) : workspace.rooms.status === 'loading' ? (
            <div className={styles.centerStateCard} role="status">
              <CircularProgress size={32} sx={{ color: colors.ink, mb: 3 }} />
              <h2 className={styles.stateTitle}>Loading workspace…</h2>
              <p className={styles.stateBody}>Connecting to workspace.</p>
            </div>
          ) : workspace.rooms.status === 'error' ? (
            <div className={styles.centerStateCard} role="alert">
              <ErrorOutlineIcon sx={{ fontSize: 44, color: colors.error, mb: 2 }} />
              <h2 className={styles.stateTitle}>Unable to load rooms</h2>
              <p className={styles.stateBody}>{workspace.rooms.message}</p>
              {preview ? (
                <Button
                  variant="contained"
                  onClick={() => {
                    preview.setScenario('normal')
                  }}
                  sx={{
                    minHeight: 44,
                    bgcolor: colors.ink,
                    color: colors.paperElevated,
                    '&:hover': { bgcolor: '#343B37' },
                  }}
                >
                  Reset to normal scenario
                </Button>
              ) : workspace.retryRooms ? (
                <Button
                  variant="contained"
                  onClick={() => workspace.retryRooms?.()}
                  sx={{
                    minHeight: 44,
                    bgcolor: colors.ink,
                    color: colors.paperElevated,
                    '&:hover': { bgcolor: '#343B37' },
                  }}
                >
                  Retry connection
                </Button>
              ) : null}
            </div>
          ) : readyRooms && readyRooms.length === 0 ? (
            <div className={styles.centerStateCard}>
              <h2 className={styles.stateTitle}>A fresh space to think.</h2>
              <p className={styles.stateBody}>Create a room to start your first conversation.</p>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setCreateDialogOpen(true)}
                sx={{
                  minHeight: 44,
                  bgcolor: colors.ink,
                  color: colors.paperElevated,
                  '&:hover': { bgcolor: '#343B37' },
                }}
              >
                Create room
              </Button>
            </div>
          ) : (
            <div className={styles.centerStateCard}>
              <h2 className={styles.stateTitle}>Threadline Workspace</h2>
              <p className={styles.stateBody}>
                Select a conversation from the sidebar or start a new room.
              </p>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setCreateDialogOpen(true)}
                sx={{
                  minHeight: 44,
                  bgcolor: colors.ink,
                  color: colors.paperElevated,
                  '&:hover': { bgcolor: '#343B37' },
                }}
              >
                Create a new room
              </Button>
            </div>
          )}
        </main>
      </div>

      {/* Create Room Dialog */}
      <CreateRoomDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreateRoom={workspace.createRoom}
        onRoomCreated={handleRoomCreated}
      />

      {/* Invite Dialog */}
      {canInvite && inviteRoomId === currentRoom?.id && currentRoom && invitations && (
        <InviteDialog
          key={currentRoom.id}
          room={currentRoom}
          port={invitations}
          onClose={() => setInviteRoomId(null)}
        />
      )}
      {/* Delete Room Dialog */}
      {maintenance && activeDeletingRoom && (
        <DeleteRoomDialog
          key={activeDeletingRoom.id}
          room={activeDeletingRoom}
          port={maintenance}
          onClose={() => { setDeletingRoom(null); setMaintenanceRevision((rev) => rev + 1) }}
          onAdmitted={() => {
            const admittedRoom = activeDeletingRoom
            setDeletingRoom(null)
            setMaintenanceRevision((rev) => rev + 1)
            setSnackbarMessage(`Room “${admittedRoom.name}” deletion started.`)
            if (roomId === admittedRoom.id) {
              onSelectRoom('')
            }
          }}
        />
      )}

      {/* Success notification only */}
      <Snackbar
        open={Boolean(snackbarMessage)}
        autoHideDuration={4000}
        onClose={() => setSnackbarMessage(null)}
        message={snackbarMessage}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        ContentProps={{
          sx: {
            bgcolor: colors.graphite,
            color: colors.paperElevated,
            border: `1px solid ${colors.dividerDark}`,
            borderRadius: '8px',
          },
        }}
      />
    </div>
  )
}
