import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Conversation, HumanMessage, Message, MessageWindow, ReadState } from '@threadline/shared'
import {
  Box,
  Button,
  CircularProgress,
  Skeleton,
  Typography,
} from '@mui/material'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import { GenerationStatus } from './GenerationStatus'
import { MessageItem } from './MessageItem'
import { colors } from '../../app/theme'

export interface MessageListProps {
  readonly conversation: ReadState<Conversation>
  readonly currentMemberUid: string
  readonly onRetryAi: () => Promise<void>
  readonly onRetryConversation: () => void
  readonly window: MessageWindow
  readonly latestSeq: number
  readonly onFreezeHistory: () => void
  readonly onLoadOlder: (anchorSeq?: number) => void
  readonly onJumpToLatest: () => void
  readonly onEditMessage?: (message: HumanMessage) => void
  readonly onDeleteMessage?: (message: HumanMessage) => void
  readonly isAiBusy?: boolean
  readonly isMaintenanceActive?: boolean
}

interface AnchorSnapshot {
  readonly id: string
  readonly seq: number
  readonly viewportOffset: number
}

const EMPTY_MESSAGES: readonly Message[] = []

export function MessageList({
  conversation,
  currentMemberUid,
  onRetryAi,
  onRetryConversation,
  window: messageWindow,
  latestSeq,
  onFreezeHistory,
  onLoadOlder,
  onJumpToLatest,
  onEditMessage,
  onDeleteMessage,
  isAiBusy = false,
  isMaintenanceActive = false,
}: MessageListProps) {
  const conversationData = conversation.data
  const messages = conversationData?.messages ?? EMPTY_MESSAGES
  const generation = conversationData?.generation ?? null

  const firstMessage = messages[0]
  const lastMessage = messages.at(-1)
  const displayedLastSeq = lastMessage ? lastMessage.seq : 0
  const hasNewerOutside = latestSeq > displayedLastSeq
  const isAtCap = messageWindow.limit === 500

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const freezeRequestedRef = useRef(false)
  const anchorRef = useRef<AnchorSnapshot | null>(null)
  const lastScrollAnchorRef = useRef<AnchorSnapshot | null>(null)
  const restoringAnchorRef = useRef(false)

  const isInitializedRef = useRef(false)
  const prevLastSeqRef = useRef<number>(0)
  const prevUpperSeqRef = useRef<number | null>(messageWindow.upperSeq)
  const highlightTimerRef = useRef<number | null>(null)


  useEffect(() => {
    if (messageWindow.upperSeq === null) {
      freezeRequestedRef.current = false
    }
  }, [messageWindow.upperSeq])

  const captureAnchor = useCallback((): AnchorSnapshot | null => {
    const container = scrollContainerRef.current
    if (!container) return null

    const containerRect = container.getBoundingClientRect()
    const items = container.querySelectorAll<HTMLElement>('[data-message-seq]')
    for (let i = 0; i < items.length; i++) {
      const el = items[i]
      const rect = el.getBoundingClientRect()
      if (rect.bottom > containerRect.top) {
        const seqAttr = el.getAttribute('data-message-seq')
        const idAttr = el.getAttribute('data-message-id')
        return {
          id: idAttr || '',
          seq: seqAttr ? Number(seqAttr) : 0,
          viewportOffset: rect.top - containerRect.top,
        }
      }
    }
    return null
  }, [])

  function handleScroll() {
    const el = scrollContainerRef.current
    if (!el) return
    const restoringAnchor = restoringAnchorRef.current
    restoringAnchorRef.current = false

    const distanceFromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    const isNear = distanceFromBottom <= 64
    isNearBottomRef.current = isNear
    setIsNearBottom(isNear)
    const anchor = !isNear || anchorRef.current ? captureAnchor() : null
    if (anchorRef.current) anchorRef.current = anchor

    if (!isNear) {
      lastScrollAnchorRef.current = anchor

      // Reader >64px from bottom requests frozen upper bound once
      if (messageWindow.upperSeq === null && !freezeRequestedRef.current) {
        freezeRequestedRef.current = true
        anchorRef.current = anchor
        onFreezeHistory()
      }
    } else {
      // Near bottom with no newer outside may return tail;
      // if latestSeq > displayedLast keep jump explicit to avoid accidentally forgetting history
      const hasNewer = latestSeq > displayedLastSeq
      if (!restoringAnchor && !hasNewer && messageWindow.upperSeq !== null) {
        freezeRequestedRef.current = false
        onJumpToLatest()
      }
    }
  }

  const handleJumpToLatest = useCallback(() => {
    onJumpToLatest()
    freezeRequestedRef.current = false
    isNearBottomRef.current = true
    setIsNearBottom(true)

    const el = scrollContainerRef.current
    if (el) {
      if (document.activeElement?.getAttribute('aria-label') === 'Jump to latest message') {
        el.focus({ preventScroll: true })
      }
      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollTo({
        top: el.scrollHeight,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      })
    }
  }, [onJumpToLatest])

  const handleLoadOlder = useCallback(() => {
    const anchor = captureAnchor()
    anchorRef.current = anchor
    onLoadOlder(anchor?.seq)
  }, [captureAnchor, onLoadOlder])

  const handleScrollToPrompt = useCallback((promptId: string) => {
    const targetEl = document.getElementById(`message-${promptId}`)
    if (targetEl) {
      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      targetEl.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'center',
      })
      targetEl.focus({ preventScroll: true })
      setHighlightedId(promptId)
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedId(null)
        highlightTimerRef.current = null
      }, 2500)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
      }
    }
  }, [])

  // Viewport anchoring and follow-latest logic
  useLayoutEffect(() => {
    if (messages.length === 0) {
      return
    }

    // Initial mount for this room: scroll to bottom
    if (!isInitializedRef.current) {
      isInitializedRef.current = true
      prevLastSeqRef.current = lastMessage?.seq ?? 0
      prevUpperSeqRef.current = messageWindow.upperSeq
      const el = scrollContainerRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
      }
      return
    }

    const prevLastSeq = prevLastSeqRef.current
    const currentLastSeq = lastMessage?.seq ?? 0
    const isNewTail = currentLastSeq > prevLastSeq

    const isResetLive =
      prevUpperSeqRef.current !== null && messageWindow.upperSeq === null

    const isNewTailNearBottom =
      isNewTail && isNearBottomRef.current && messageWindow.upperSeq === null

    const shouldFollowLatest = isResetLive || isNewTailNearBottom

    if (shouldFollowLatest) {
      const el = scrollContainerRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
      }
      isNearBottomRef.current = true
      setIsNearBottom(true)
      anchorRef.current = null
    } else {
      // Restore stable anchor on same-room window handoff / edits
      const anchor =
        anchorRef.current ||
        (!isNearBottomRef.current ? lastScrollAnchorRef.current : null)

      if (anchor && scrollContainerRef.current) {
        const container = scrollContainerRef.current
        const targetEl =
          (anchor.seq ? container.querySelector<HTMLElement>(`[data-message-seq="${anchor.seq}"]`) : null) ??
          (anchor.id ? container.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`) : null)

        if (targetEl) {
          const containerRect = container.getBoundingClientRect()
          const targetRect = targetEl.getBoundingClientRect()
          const currentOffset = targetRect.top - containerRect.top
          const diff = currentOffset - anchor.viewportOffset
          if (Math.abs(diff) > 0.5) {
            const previousTop = container.scrollTop
            // Restoring an anchor is not a request to collapse back to the live tail.
            restoringAnchorRef.current = true
            container.scrollTop += diff
            if (container.scrollTop === previousTop) restoringAnchorRef.current = false
          }
        }
      }
      if (conversation.status === 'ready') anchorRef.current = null
    }

    prevLastSeqRef.current = currentLastSeq
    prevUpperSeqRef.current = messageWindow.upperSeq
  }, [messages, messageWindow.upperSeq, lastMessage, conversation.status])

  const prevGenStateRef = useRef<string | null>(null)
  useEffect(() => {
    if (generation?.state === 'pending' && prevGenStateRef.current !== 'pending') {
      if (isNearBottomRef.current && messageWindow.upperSeq === null) {
        const el = scrollContainerRef.current
        if (el) {
          el.scrollTo({
            top: el.scrollHeight,
            behavior: 'smooth',
          })
        }
      }
    }
    prevGenStateRef.current = generation?.state ?? null
  }, [generation?.state, messageWindow.upperSeq])

  // Cold loading: no data and status is loading
  if (conversation.status === 'loading' && messages.length === 0) {
    return (
      <Box
        role="status"
        aria-live="polite"
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
          gap: 2,
          color: colors.inkSecondary,
        }}
      >
        <Skeleton
          variant="rounded"
          width="70%"
          height={64}
          sx={{
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
              '&::after': { animation: 'none' },
            },
          }}
        />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          Loading conversation…
        </Typography>
      </Box>
    )
  }

  // Cold error: no data and status is error
  if (conversation.status === 'error' && messages.length === 0) {
    return (
      <Box
        role="alert"
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
          gap: 1.5,
          color: colors.error,
          textAlign: 'center',
        }}
      >
        <ErrorOutlineIcon sx={{ fontSize: 36 }} />
        <Typography variant="body1" sx={{ fontWeight: 600 }}>
          {conversation.message || 'Unable to load conversation.'}
        </Typography>
        <Button
          variant="outlined"
          color="error"
          onClick={onRetryConversation}
          sx={{ minHeight: 44, minWidth: 44, textTransform: 'none' }}
        >
          Retry loading messages
        </Button>
      </Box>
    )
  }

  // Empty room
  if (messages.length === 0 && !generation) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
          textAlign: 'center',
          color: colors.inkSecondary,
        }}
      >
        <Typography variant="body1" sx={{ fontWeight: 600, color: colors.ink, mb: 1 }}>
          No messages in this room yet
        </Typography>
        <Typography variant="body2" sx={{ maxWidth: 420 }}>
          Send a message to start the conversation.
        </Typography>
      </Box>
    )
  }

  const showJumpPill = hasNewerOutside || !isNearBottom
  const firstSeq = firstMessage?.seq ?? 0

  return (
    <Box
      ref={scrollContainerRef}
      onScroll={handleScroll}
      tabIndex={0}
      aria-label="Conversation transcript"
      sx={{
        flex: 1,
        overflowY: 'auto',
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        '&:focus-visible': {
          outline: `2px solid ${colors.ink}`,
          outlineOffset: '-2px',
        },
      }}
    >
      <Box
        sx={{
          maxWidth: 760,
          width: '100%',
          mx: 'auto',
          px: { xs: 2, sm: 3 },
          py: 3,
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        {firstSeq > 1 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            <Button
              variant="outlined"
              size="small"
              onClick={handleLoadOlder}
              onMouseDown={(e) => e.preventDefault()}
              disabled={conversation.status !== 'ready'}
              startIcon={
                conversation.status === 'loading' ? (
                  <CircularProgress size={16} sx={{ color: colors.inkSecondary }} />
                ) : (
                  <ArrowUpwardIcon sx={{ fontSize: 16 }} />
                )
              }
              aria-label={isAtCap ? 'Load earlier 500 messages with overlap' : 'Load older messages'}
              sx={{
                minHeight: 44,
                minWidth: 44,
                textTransform: 'none',
                color: colors.inkSecondary,
                borderColor: colors.dividerLight,
                fontSize: '0.8125rem',
                '&:hover': {
                  borderColor: colors.ink,
                  color: colors.ink,
                  bgcolor: 'rgba(0, 0, 0, 0.04)',
                },
                '&:focus-visible': {
                  outline: `2px solid ${colors.ink}`,
                  outlineOffset: '2px',
                },
              }}
            >
              {isAtCap
                ? 'Load earlier 500 messages (sliding window with overlap)'
                : 'Load older messages'}
            </Button>
          </Box>
        ) : (
          <Typography
            variant="caption"
            sx={{
              color: colors.inkSecondary,
              py: 1.5,
              textAlign: 'center',
              display: 'block',
            }}
          >
            Beginning of conversation
          </Typography>
        )}

        <Typography variant="caption" sx={{ color: colors.inkSecondary, textAlign: 'center', mb: 2 }}>
          Messages {firstSeq}–{displayedLastSeq}{hasNewerOutside ? ` · Latest ${latestSeq}` : ''}
        </Typography>

        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            currentMemberUid={currentMemberUid}
            onScrollToPrompt={handleScrollToPrompt}
            isHighlighted={highlightedId === message.id}
            onEdit={onEditMessage}
            onDelete={onDeleteMessage}
            isAiBusy={isAiBusy}
            isMaintenanceActive={isMaintenanceActive}
          />
        ))}

        <GenerationStatus generation={generation} onRetryAi={onRetryAi} />
      </Box>

      {showJumpPill && (
        <Box
          sx={{
            position: 'sticky',
            bottom: 16,
            alignSelf: 'center',
            zIndex: 10,
            pointerEvents: 'auto',
          }}
        >
          <Button
            variant="contained"
            size="small"
            onClick={handleJumpToLatest}
            onMouseDown={(e) => e.preventDefault()}
            startIcon={<ArrowDownwardIcon sx={{ fontSize: 16 }} />}
            aria-label="Jump to latest message"
            sx={{
              bgcolor: colors.ink,
              color: colors.paperElevated,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.16)',
              borderRadius: '9999px',
              px: 2.5,
              minHeight: 44,
              minWidth: 44,
              fontSize: '0.8125rem',
              fontWeight: 600,
              textTransform: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              '&:hover': {
                bgcolor: colors.darkRaised,
              },
              '&:focus-visible': {
                outline: `2px solid ${colors.ink}`,
                outlineOffset: '2px',
              },
            }}
          >
            {hasNewerOutside ? `${latestSeq - displayedLastSeq} later · ` : ''}Jump to latest
          </Button>
        </Box>
      )}
    </Box>
  )
}
