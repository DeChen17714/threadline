import type { Conversation, HumanMessage, Member, MessageIntent, MessageWindow, ReadState, Room } from '@threadline/shared'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { Composer } from './Composer'
import { EditMessageDialog } from './EditMessageDialog'
import { DeleteMessageDialog } from './DeleteMessageDialog'
import { MessageList } from './MessageList'
import { RoomHeader } from './RoomHeader'
import { colors } from '../../app/theme'
import type { MessageDeleteState, MessageEditDraft } from '../../services/workspace'

export interface ChatPanelProps {
  readonly room: Room
  readonly conversation: ReadState<Conversation>
  readonly member: Member
  readonly draft: string
  readonly onDraftChange: (text: string) => void
  readonly pending: boolean
  readonly error: string | null
  readonly onSend: (intent: MessageIntent) => Promise<void>
  readonly onRetry: () => Promise<void>
  readonly onRetryAi: () => Promise<void>
  readonly canRetry?: boolean
  readonly onInvite?: () => void
  readonly onDelete?: () => void
  readonly askAiAvailable: boolean
  readonly failedText: string | null
  readonly onRetryConversation: () => void
  readonly window: MessageWindow
  readonly onFreezeHistory: () => void
  readonly onLoadOlder: (anchorSeq?: number) => void
  readonly onJumpToLatest: () => void
  readonly onEditMessage?: (input: { messageId: string; expectedVersion: number; text: string; requestId?: string }) => Promise<void>
  readonly editDrafts?: Record<string, MessageEditDraft>
  readonly onEditDraftChange?: (messageId: string, draft: string, requestId: string, expectedVersion: number) => void
  readonly onDeleteMessage?: (input: { messageId: string; expectedVersion: number; requestId?: string }) => Promise<void>
  readonly deleteStates?: Record<string, MessageDeleteState>
  readonly onDismissDeleteState?: (messageId: string) => void
  readonly maintenanceWorking?: boolean
  readonly maintenanceError?: string | null
  readonly onResumeMaintenance?: () => void
}

function subscribeConnection(notify: () => void) {
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}
const isOffline = () => !navigator.onLine

export function ChatPanel({
  room,
  conversation,
  member,
  draft,
  onDraftChange,
  pending,
  error,
  onSend,
  onRetry,
  onRetryAi,
  canRetry,
  onInvite,
  onDelete,
  askAiAvailable,
  failedText,
  onRetryConversation,
  window,
  onFreezeHistory,
  onLoadOlder,
  onJumpToLatest,
  onEditMessage,
  editDrafts,
  onEditDraftChange,
  maintenanceWorking = false,
  maintenanceError = null,
  onResumeMaintenance,
  onDeleteMessage,
  deleteStates,
  onDismissDeleteState,
}: ChatPanelProps) {
  const [editingMessage, setEditingMessage] = useState<HumanMessage | null>(null)
  const [deletingMessage, setDeletingMessage] = useState<HumanMessage | null>(null)
  const focusAfterDelete = useRef<string | null>(null)
  useEffect(() => {
    if (deletingMessage || !focusAfterDelete.current) return
    const messageId = focusAfterDelete.current
    focusAfterDelete.current = null
    const frame = requestAnimationFrame(() => {
      document.getElementById(`message-${messageId}`)?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [deletingMessage])
  const offline = useSyncExternalStore(subscribeConnection, isOffline)
  const isAiBusy =
    conversation.status === 'ready' && conversation.data.generation?.state === 'pending'
  const isMaintenanceActive =
    room.maintenanceState === 'updating-context' || Boolean(room.maintenanceId)
  const currentEditingMessage = editingMessage
    ? conversation.data?.messages.find((message): message is HumanMessage => message.id === editingMessage.id && message.kind === 'human') ?? editingMessage
    : null
  const currentDeletingMessage = deletingMessage
    ? conversation.data?.messages.find((message): message is HumanMessage => message.id === deletingMessage.id && message.kind === 'human') ?? deletingMessage
    : null
  return (
    <Box
      component="section"
      aria-label={`Chat for ${room.name}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        minHeight: 0,
        bgcolor: colors.paper,
        overflow: 'hidden',
      }}
    >
      <RoomHeader room={room} onInvite={onInvite} onDelete={onDelete} />

      {isMaintenanceActive && (
        <Box
          role="status"
          aria-live="polite"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: 0.75,
            bgcolor: '#FFF7ED',
            borderBottom: `1px solid ${colors.dividerLight}`,
            gap: 1.5,
            flexShrink: 0,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {maintenanceWorking && <CircularProgress size={16} sx={{ color: colors.inkSecondary }} />}
            <Typography variant="caption" sx={{ color: colors.ink, fontWeight: 500 }}>
              Updating conversation context
            </Typography>
          </Box>
          {maintenanceError && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption" sx={{ color: colors.error }}>
                {maintenanceError}
              </Typography>
              {onResumeMaintenance && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onResumeMaintenance}
                  disabled={maintenanceWorking}
                  sx={{ minHeight: 44, minWidth: 44, textTransform: 'none', py: 0, px: 1, fontSize: '0.75rem' }}
                >
                  Resume
                </Button>
              )}
            </Box>
          )}
        </Box>
      )}
      {conversation.status === 'error' && Boolean(conversation.data?.messages.length) && (
        <Box
          role="alert"
          sx={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5,
            px: 2, py: 1, flexShrink: 0, bgcolor: '#FDF2F0', color: colors.error,
            borderBottom: `1px solid ${colors.error}`,
          }}
        >
          <Typography variant="body2" sx={{ flex: '1 1 200px', minWidth: 0 }}>
            {conversation.message}
          </Typography>
          <Button
            variant="outlined"
            color="error"
            onClick={onRetryConversation}
            onMouseDown={(event) => event.preventDefault()}
            sx={{ minHeight: 44, minWidth: 44, textTransform: 'none' }}
          >
            Retry
          </Button>
        </Box>
      )}

      <MessageList
        key={room.id}
        conversation={conversation}
        currentMemberUid={member.uid}
        onRetryAi={onRetryAi}
        onRetryConversation={onRetryConversation}
        window={window}
        latestSeq={room.latestSeq ?? conversation.data?.messages.at(-1)?.seq ?? 0}
        onFreezeHistory={onFreezeHistory}
        onLoadOlder={onLoadOlder}
        onJumpToLatest={onJumpToLatest}
        onEditMessage={(msg) => setEditingMessage(msg)}
        onDeleteMessage={(msg) => setDeletingMessage(msg)}
        isAiBusy={isAiBusy}
        isMaintenanceActive={isMaintenanceActive}
      />
      <Composer
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={onSend}
        pending={pending}
        error={error}
        onRetry={onRetry}
        canRetry={canRetry}
        isAiBusy={isAiBusy}
        askAiAvailable={askAiAvailable}
        memberCount={room.members.length}
        offline={offline}
        failedText={failedText}
        isMaintenanceActive={isMaintenanceActive}
      />

      <EditMessageDialog
        key={editingMessage ? `${member.uid}/${room.id}/${editingMessage.id}` : 'closed'}
        open={Boolean(editingMessage)}
        message={currentEditingMessage}
        onClose={() => setEditingMessage(null)}
        onSave={async (messageId, expectedVersion, text, requestId) => {
          if (!onEditMessage) throw new Error('Message editing is unavailable.')
          await onEditMessage({ messageId, expectedVersion, text, requestId })
        }}
        isAiBusy={isAiBusy}
        isMaintenanceActive={isMaintenanceActive}
        initialDraft={editingMessage ? editDrafts?.[editingMessage.id]?.draft : undefined}
        initialRequestId={editingMessage ? editDrafts?.[editingMessage.id]?.requestId : undefined}
        initialError={editingMessage ? editDrafts?.[editingMessage.id]?.error : undefined}
        initialExpectedVersion={editingMessage ? editDrafts?.[editingMessage.id]?.expectedVersion : undefined}
        initialUncertain={editingMessage ? editDrafts?.[editingMessage.id]?.uncertain : undefined}
        onDraftChange={onEditDraftChange}
      />

      <DeleteMessageDialog
        key={deletingMessage ? `${member.uid}/${room.id}/${deletingMessage.id}` : 'delete-closed'}
        open={Boolean(deletingMessage)}
        message={currentDeletingMessage}
        onClose={(deletedMessageId) => {
          focusAfterDelete.current = deletedMessageId ?? null
          setDeletingMessage(null)
        }}
        onDelete={async (messageId, expectedVersion, requestId) => {
          if (!onDeleteMessage) throw new Error('Message deletion is unavailable.')
          await onDeleteMessage({ messageId, expectedVersion, requestId })
        }}
        isAiBusy={isAiBusy}
        isMaintenanceActive={isMaintenanceActive}
        initialRequestId={deletingMessage ? deleteStates?.[deletingMessage.id]?.requestId : undefined}
        initialError={deletingMessage ? deleteStates?.[deletingMessage.id]?.error : undefined}
        initialExpectedVersion={deletingMessage ? deleteStates?.[deletingMessage.id]?.expectedVersion : undefined}
        initialUncertain={deletingMessage ? deleteStates?.[deletingMessage.id]?.uncertain : undefined}
        onDismissState={onDismissDeleteState}
      />
    </Box>
  )
}
