import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Conversation, Generation, MessageIntent, MessageWindow, ReadState, Room } from '@threadline/shared'
import { CommandRejectedError, CommandUncertainError, type MessageDeleteState, type MessageEditDraft, type WorkspacePort } from '../../services/workspace'

function readSource<T>(listen: (notify: (state: ReadState<T>) => void) => () => void, initialData?: T, onData?: (data: T) => void) {
  let snapshot: ReadState<T> = { status: 'loading', data: initialData }
  const listeners = new Set<() => void>()
  let unsubscribe: (() => void) | undefined
  let epoch = 0
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify)
      if (listeners.size === 1) {
        const ownEpoch = ++epoch
        unsubscribe = listen((next) => {
          if (ownEpoch !== epoch) return
          if (next.status === 'ready') onData?.(next.data)
          snapshot = next.status === 'ready' ? next : { ...next, data: next.data ?? snapshot.data }
          for (const listener of listeners) listener()
        })
      }
      return () => {
        listeners.delete(notify)
        if (listeners.size === 0) {
          epoch++
          unsubscribe?.()
          unsubscribe = undefined
          snapshot = { status: 'loading' }
        }
      }
    },
  }
}

type SendInput = Parameters<WorkspacePort['send']>[0]

interface DraftState {
  draft: string
  pending: boolean
  pendingCommand: SendInput | null
  error: string | null
  failed: SendInput | null
}

interface RetryState {
  readonly pending: boolean
  readonly requestId: string | null
  readonly generationId: string | null
  readonly promptMessageId: string | null
  readonly error: string | null
  readonly uncertain: boolean
}

const emptyDraft: DraftState = { draft: '', pending: false, pendingCommand: null, error: null, failed: null }
const liveWindow: MessageWindow = { upperSeq: null, limit: 50 }

export function useWorkspace(port: WorkspacePort, roomId: string | null) {
  const key = `${port.member.uid}/${roomId ?? ''}`
  const [windows, setWindows] = useState<Record<string, MessageWindow>>({})
  const window = windows[key] ?? liveWindow
  const conversationCache = useMemo(() => ({ port, roomId, data: undefined as Conversation | undefined }), [port, roomId])
  const roomsSource = useMemo(() => readSource<readonly Room[]>((notify) => port.subscribeRooms(notify)), [port])
  const roomSource = useMemo(() => readSource<Room | null>((notify) => {
    if (!roomId) {
      notify({ status: 'ready', data: null })
      return () => {}
    }
    return port.subscribeRoom(roomId, notify)
  }), [port, roomId])
  const conversationSource = useMemo(() => readSource<Conversation>((notify) => {
    if (!conversationCache.roomId) { notify({ status: 'ready', data: { messages: [], generation: null } }); return () => {} }
    return conversationCache.port.subscribeConversation(conversationCache.roomId, notify, window)
  }, conversationCache.data, (data) => { conversationCache.data = data }), [conversationCache, window])
  const rooms = useSyncExternalStore(roomsSource.subscribe, roomsSource.getSnapshot)
  const selectedRoom = useSyncExternalStore(roomSource.subscribe, roomSource.getSnapshot)
  const conversation = useSyncExternalStore(conversationSource.subscribe, conversationSource.getSnapshot)
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [retries, setRetries] = useState<Record<string, RetryState>>({})
  const activeRequests = useRef(new Map<string, string>())
  const activeRetryRequests = useRef(new Map<string, string>())
  const [editDrafts, setEditDrafts] = useState<Record<string, MessageEditDraft>>({})
  const activeEditRequests = useRef(new Map<string, string>())
  const [deleteStates, setDeleteStates] = useState<Record<string, MessageDeleteState>>({})
  const activeDeleteRequests = useRef(new Map<string, string>())
  const [maintenanceStatus, setMaintenanceStatus] = useState<{ jobId: string | null; working: boolean; error: string | null }>({
    jobId: null, working: false, error: null,
  })
  const lifetime = useMemo(() => ({ active: true, port }), [port])
  useEffect(() => {
    lifetime.active = true
    return () => { lifetime.active = false }
  }, [lifetime])
  const current = drafts[key] ?? emptyDraft
  const currentRetry = retries[key]
  useEffect(() => {
    if (conversation.status !== 'ready') return
    const messages = conversation.data.messages
    const generation = conversation.data.generation

    const checkAndConfirm = (command: SendInput | null, isPending: boolean) => {
      if (!command) return false
      const isMatch = messages.some(
        (message) =>
          message.id === command.messageId &&
          message.kind === 'human' &&
          message.authorId === port.member.uid &&
          message.text === command.text,
      )
      if (!isMatch) return false

      if (command.intent === 'ask-ai') {
        setWindows((prev) => (prev[key] ?? liveWindow).upperSeq === null
          ? prev : { ...prev, [key]: liveWindow })
      }
      if (activeRequests.current.get(key) === command.requestId) {
        activeRequests.current.delete(key)
      }
      setDrafts((prev) => {
        const stored = prev[key] ?? emptyDraft
        const matches = isPending
          ? stored.pendingCommand?.requestId === command.requestId
          : stored.failed?.requestId === command.requestId
        if (!matches) return prev
        return {
          ...prev,
          [key]: {
            ...stored,
            pending: false,
            pendingCommand: null,
            failed: null,
            error: null,
            draft: stored.draft === command.text ? '' : stored.draft,
          },
        }
      })
      return true
    }

    if (current.pendingCommand) {
      checkAndConfirm(current.pendingCommand, true)
    }
    if (current.failed) {
      checkAndConfirm(current.failed, false)
    }

    if (currentRetry?.generationId && (!generation || generation.id !== currentRetry.generationId || generation.state === 'pending')) {
      if (!currentRetry.pending) {
        setRetries((prev) => {
          if (!prev[key]) return prev
          const rest = { ...prev }
          delete rest[key]
          return rest
        })
      }
    }

    for (const msg of messages) {
      if (msg.kind === 'human' && msg.authorId === port.member.uid) {
        const editKey = `${port.member.uid}/${roomId ?? ''}/${msg.id}`
        const pendingEdit = editDrafts[editKey]
        if (pendingEdit?.submittedText === msg.text && msg.version === (pendingEdit.expectedVersion ?? 0) + 1) {
          if (activeEditRequests.current.get(editKey) === pendingEdit.requestId) activeEditRequests.current.delete(editKey)
          setEditDrafts((prev) => {
            if (prev[editKey]?.requestId !== pendingEdit.requestId) return prev
            const next = { ...prev }
            delete next[editKey]
            return next
          })
        }
        const deleteKey = `${port.member.uid}/${roomId ?? ''}/${msg.id}`
        const pendingDelete = deleteStates[deleteKey]
        if (pendingDelete && msg.deletedAt && msg.version === (pendingDelete.expectedVersion ?? 0) + 1) {
          if (activeDeleteRequests.current.get(deleteKey) === pendingDelete.requestId) activeDeleteRequests.current.delete(deleteKey)
          setDeleteStates((prev) => {
            if (prev[deleteKey]?.requestId !== pendingDelete.requestId) return prev
            const next = { ...prev }
            delete next[deleteKey]
            return next
          })
        }
      }
    }
  }, [conversation, current.pendingCommand, current.failed, currentRetry, editDrafts, deleteStates, key, port.member.uid, roomId])

  function setDraft(draft: string) {
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? emptyDraft), draft, error: prev[key]?.failed ? prev[key].error : null } }))
  }

  async function submit(input: SendInput) {
    const targetKey = `${port.member.uid}/${input.roomId}`
    const currentActive = activeRequests.current.get(targetKey)
    if (currentActive) return

    activeRequests.current.set(targetKey, input.requestId)
    setDrafts((prev) => ({
      ...prev,
      [targetKey]: {
        ...(prev[targetKey] ?? emptyDraft),
        pending: true,
        pendingCommand: input,
        error: null,
        failed: null,
      },
    }))

    try {
      await port.send(input)
      if (!lifetime.active) return

      const isStillActive = activeRequests.current.get(targetKey) === input.requestId

      if (isStillActive) {
        setWindows((prev) => ({ ...prev, [targetKey]: liveWindow }))
        activeRequests.current.delete(targetKey)
        setDrafts((prev) => {
          const stored = prev[targetKey] ?? emptyDraft
          if (stored.pendingCommand?.requestId !== input.requestId) return prev
          return {
            ...prev,
            [targetKey]: {
              ...stored,
              draft: stored.draft === input.text ? '' : stored.draft,
              pending: false,
              pendingCommand: null,
              error: null,
              failed: null,
            },
          }
        })
      }
    } catch (error) {
      if (!lifetime.active) return

      const isStillActive = activeRequests.current.get(targetKey) === input.requestId

      if (!isStillActive) {
        return
      }
      activeRequests.current.delete(targetKey)

      const isDefinitelyRejected = error instanceof CommandRejectedError

      setDrafts((prev) => {
        const stored = prev[targetKey] ?? emptyDraft
        if (stored.pendingCommand?.requestId !== input.requestId) return prev
        return {
          ...prev,
          [targetKey]: {
            ...stored,
            pending: false,
            pendingCommand: null,
            error: error instanceof Error ? error.message : 'Message could not be sent. Try again.',
            failed: isDefinitelyRejected ? null : input,
          },
        }
      })
    } finally {
      if (!lifetime.active && activeRequests.current.get(targetKey) === input.requestId) {
        activeRequests.current.delete(targetKey)
      }
    }
  }

  async function send(intent: MessageIntent) {
    if (!roomId || !current.draft.trim() || current.failed) return
    if (isMaintenanceActive) {
      setDrafts((prev) => ({ ...prev, [key]: { ...current, error: 'Updating conversation context. Messages cannot be sent right now.' } }))
      return
    }
    if (current.draft.length > 4000 || new TextEncoder().encode(current.draft).length > 16384) {
      setDrafts((prev) => ({ ...prev, [key]: { ...current, error: 'Use at most 4,000 characters (16 KiB). Your draft has not been sent.' } }))
      return
    }
    await submit({ requestId: crypto.randomUUID(), roomId, messageId: crypto.randomUUID(), text: current.draft, intent })
  }

  async function retrySend() {
    if (current.failed) await submit(current.failed)
  }

  async function retryAi() {
    if (!roomId || conversation.status !== 'ready' || !conversation.data.generation || isMaintenanceActive) return
    const gen = conversation.data.generation
    if (gen.state !== 'failed') return

    if (!gen.canRetry) {
      setRetries((prev) => ({
        ...prev,
        [key]: {
          pending: false,
          requestId: null,
          generationId: gen.id ?? null,
          promptMessageId: gen.promptMessageId,
          error: gen.retryIneligibleReason ?? 'This reply cannot be retried.',
          uncertain: false,
        },
      }))
      return
    }

    const generationId = gen.id
    if (!generationId) return

    const targetKey = `${port.member.uid}/${roomId}`
    const active = activeRetryRequests.current.get(targetKey)
    if (active) return

    const previousRequestId = retries[targetKey]?.generationId === gen.id ? retries[targetKey]?.requestId : null
    const requestId = previousRequestId ?? crypto.randomUUID()
    activeRetryRequests.current.set(targetKey, requestId)

    setRetries((prev) => ({
      ...prev,
      [targetKey]: {
        pending: true,
        requestId,
        generationId,
        promptMessageId: gen.promptMessageId,
        error: null,
        uncertain: false,
      },
    }))

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      activeRetryRequests.current.delete(targetKey)
      setRetries((prev) => ({
        ...prev,
        [targetKey]: {
          pending: false,
          requestId,
          generationId,
          promptMessageId: gen.promptMessageId,
          error: 'Retry status is uncertain. You are offline; check your connection and retry.',
          uncertain: true,
        },
      }))
      return
    }

    try {
      await port.retryReply({
        requestId,
        roomId,
        promptMessageId: gen.promptMessageId,
        generationId,
      })
      if (!lifetime.active) return
      setRetries((prev) => {
        const stored = prev[targetKey]
        if (stored?.requestId !== requestId) return prev
        return {
          ...prev,
          [targetKey]: {
            ...stored,
            pending: false,
            error: null,
            uncertain: false,
          },
        }
      })
    } catch (error) {
      if (!lifetime.active) return
      const isUncertain = error instanceof CommandUncertainError
      setRetries((prev) => {
        const stored = prev[targetKey]
        if (stored?.requestId !== requestId) return prev
        return {
          ...prev,
          [targetKey]: {
            ...stored,
            pending: false,
            error: error instanceof Error ? error.message : 'Reply could not be retried.',
            uncertain: isUncertain,
          },
        }
      })
    } finally {
      if (activeRetryRequests.current.get(targetKey) === requestId) {
        activeRetryRequests.current.delete(targetKey)
      }
    }
  }

  const currentRoom = selectedRoom.status === 'ready' ? selectedRoom.data : null
  const maintenanceId = currentRoom?.maintenanceId ?? null
  const isMaintenanceActive = Boolean(
    maintenanceId &&
    (currentRoom?.maintenanceState === 'updating-context' || !currentRoom?.maintenanceState),
  )

  const maintenanceCycle = useMemo(() => ({ port, roomId, maintenanceId, active: true, working: false, timer: undefined as number | undefined }),
    [port, roomId, maintenanceId])
  const advance = useCallback(async () => {
    if (!roomId || !maintenanceId || !maintenanceCycle.active || maintenanceCycle.working) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setMaintenanceStatus({ jobId: maintenanceId, working: false, error: 'Context update is paused offline. Reconnect to resume.' })
      return
    }
    maintenanceCycle.working = true
    setMaintenanceStatus({ jobId: maintenanceId, working: true, error: null })
    try {
      const result = await port.resumeMaintenance(maintenanceId)
      if (!maintenanceCycle.active) return
      if (result.status === 'pending') {
        maintenanceCycle.timer = globalThis.setTimeout(() => { if (maintenanceCycle.active) void advance() }, 50)
      } else if (result.status !== 'complete') {
        setMaintenanceStatus({ jobId: maintenanceId, working: false, error: 'Context update is incomplete. Resume to retry.' })
      }
    } catch (error) {
      if (!maintenanceCycle.active) return
      setMaintenanceStatus({ jobId: maintenanceId, working: false,
        error: error instanceof Error ? error.message : 'Context update could not finish. Resume to retry.' })
    } finally {
      maintenanceCycle.working = false
      if (maintenanceCycle.active) setMaintenanceStatus(prev => prev.jobId === maintenanceId ? { ...prev, working: false } : prev)
    }
  }, [roomId, maintenanceId, maintenanceCycle, port])

  useEffect(() => {
    maintenanceCycle.active = true
    if (isMaintenanceActive) void advance()
    const onOnline = () => { if (isMaintenanceActive) void advance() }
    globalThis.addEventListener('online', onOnline)
    return () => {
      maintenanceCycle.active = false
      clearTimeout(maintenanceCycle.timer)
      globalThis.removeEventListener('online', onOnline)
    }
  }, [isMaintenanceActive, maintenanceCycle, advance])

  const maintenanceWorking = maintenanceStatus.jobId === maintenanceId && maintenanceStatus.working
  const maintenanceError = maintenanceStatus.jobId === maintenanceId ? maintenanceStatus.error : null
  const resumeMaintenance = advance

  const setEditDraft = useCallback((messageId: string, draft: string, requestId?: string, expectedVersion?: number) => {
    const editKey = `${port.member.uid}/${roomId ?? ''}/${messageId}`
    setEditDrafts(prev => {
      const stored = prev[editKey]
      if (stored?.pending || stored?.uncertain) return prev
      return { ...prev, [editKey]: {
        ...stored, draft, requestId: requestId ?? crypto.randomUUID(),
        expectedVersion: expectedVersion ?? stored?.expectedVersion, error: null, pending: false, uncertain: false,
      } }
    })
  }, [port.member.uid, roomId])

  async function editMessage(input: {
    messageId: string
    expectedVersion: number
    text: string
    requestId?: string
  }): Promise<void> {
    if (!roomId) return
    if (isMaintenanceActive) {
      throw new CommandRejectedError('Updating conversation context. Message edits are paused.')
    }
    const editKey = `${port.member.uid}/${roomId}/${input.messageId}`
    if (activeEditRequests.current.get(editKey)) throw new CommandRejectedError('This edit is already awaiting confirmation.')
    const retained = editDrafts[editKey]
    if (retained?.uncertain && retained.submittedText !== input.text) {
      throw new CommandRejectedError('Confirm the saved edit before changing its text.')
    }

    const requestId = input.requestId ?? editDrafts[editKey]?.requestId ?? crypto.randomUUID()
    activeEditRequests.current.set(editKey, requestId)

    setEditDrafts((prev) => ({
      ...prev,
      [editKey]: {
        draft: input.text,
        requestId,
        error: null,
        pending: true,
        expectedVersion: input.expectedVersion,
        submittedText: input.text,
        uncertain: false,
      },
    }))

    try {
      await port.editMessage({
        requestId,
        roomId,
        messageId: input.messageId,
        expectedVersion: input.expectedVersion,
        text: input.text,
      })
      if (!lifetime.active || activeEditRequests.current.get(editKey) !== requestId) return
      setEditDrafts((prev) => {
        if (prev[editKey]?.requestId !== requestId) return prev
        const next = { ...prev }
        delete next[editKey]
        return next
      })
    } catch (err) {
      if (!lifetime.active || activeEditRequests.current.get(editKey) !== requestId) return
      const errorMsg = err instanceof Error ? err.message : 'Message could not be edited.'
      setEditDrafts(prev => prev[editKey]?.requestId !== requestId ? prev : ({
        ...prev,
        [editKey]: { ...prev[editKey], error: errorMsg, pending: false, uncertain: err instanceof CommandUncertainError },
      }))
      throw err
    } finally {
      if (activeEditRequests.current.get(editKey) === requestId) {
        activeEditRequests.current.delete(editKey)
      }
    }
  }

  async function deleteMessage(input: {
    messageId: string
    expectedVersion: number
    requestId?: string
  }): Promise<void> {
    if (!roomId) return
    if (isMaintenanceActive) {
      throw new CommandRejectedError('Updating conversation context. Message deletions are paused.')
    }
    const deleteKey = `${port.member.uid}/${roomId}/${input.messageId}`
    if (activeDeleteRequests.current.get(deleteKey)) throw new CommandRejectedError('This deletion is already awaiting confirmation.')

    const requestId = input.requestId ?? deleteStates[deleteKey]?.requestId ?? crypto.randomUUID()
    activeDeleteRequests.current.set(deleteKey, requestId)

    setDeleteStates((prev) => ({
      ...prev,
      [deleteKey]: {
        requestId,
        expectedVersion: input.expectedVersion,
        pending: true,
        error: null,
        uncertain: false,
      },
    }))

    try {
      await port.deleteMessage({
        requestId,
        roomId,
        messageId: input.messageId,
        expectedVersion: input.expectedVersion,
      })
      if (!lifetime.active || activeDeleteRequests.current.get(deleteKey) !== requestId) return
      setDeleteStates((prev) => {
        if (prev[deleteKey]?.requestId !== requestId) return prev
        const next = { ...prev }
        delete next[deleteKey]
        return next
      })
    } catch (err) {
      if (!lifetime.active || activeDeleteRequests.current.get(deleteKey) !== requestId) return
      const errorMsg = err instanceof Error ? err.message : 'Message could not be deleted.'
      setDeleteStates(prev => prev[deleteKey]?.requestId !== requestId ? prev : ({
        ...prev,
        [deleteKey]: { ...prev[deleteKey], error: errorMsg, pending: false, uncertain: err instanceof CommandUncertainError },
      }))
      throw err
    } finally {
      if (activeDeleteRequests.current.get(deleteKey) === requestId) {
        activeDeleteRequests.current.delete(deleteKey)
      }
    }
  }

  const dismissDeleteState = useCallback((messageId: string) => {
    const deleteKey = `${port.member.uid}/${roomId ?? ''}/${messageId}`
    setDeleteStates((prev) => {
      const stored = prev[deleteKey]
      if (!stored || stored.pending) return prev
      const next = { ...prev }
      delete next[deleteKey]
      return next
    })
  }, [port.member.uid, roomId])

  const roomDeleteStates = useMemo(() => {
    const prefix = `${port.member.uid}/${roomId ?? ''}/`
    const statesForRoom: Record<string, MessageDeleteState> = {}
    for (const [k, v] of Object.entries(deleteStates)) {
      if (k.startsWith(prefix)) {
        statesForRoom[k.slice(prefix.length)] = v
      }
    }
    return statesForRoom
  }, [deleteStates, port.member.uid, roomId])

  const roomEditDrafts = useMemo(() => {
    const prefix = `${port.member.uid}/${roomId ?? ''}/`
    const draftsForRoom: Record<string, MessageEditDraft> = {}
    for (const [k, v] of Object.entries(editDrafts)) {
      if (k.startsWith(prefix)) {
        draftsForRoom[k.slice(prefix.length)] = v
      }
    }
    return draftsForRoom
  }, [editDrafts, port.member.uid, roomId])

  const decoratedConversation = useMemo<ReadState<Conversation>>(() => {
    if (conversation.status !== 'ready' || !conversation.data.generation) {
      return conversation
    }
    const gen = conversation.data.generation
    const retryState = retries[key]
    const matchesCurrent = retryState?.generationId === gen.id
    const decoratedGen: Generation = {
      ...gen,
      retryPending: matchesCurrent ? retryState.pending : false,
      retryError: matchesCurrent ? retryState.error : (gen.canRetry ? null : gen.retryIneligibleReason ?? null),
      retryUncertain: matchesCurrent ? retryState.uncertain : false,
    }
    return {
      ...conversation,
      data: {
        ...conversation.data,
        generation: decoratedGen,
      },
    }
  }, [conversation, retries, key])
  function freezeHistory() {
    const lastSeq = conversation.data?.messages.at(-1)?.seq
    if (window.upperSeq === null && lastSeq) setWindows((prev) => ({ ...prev, [key]: { ...window, upperSeq: lastSeq } }))
  }

  function loadOlder(anchorSeq?: number) {
    if (conversation.status !== 'ready') return
    const messages = conversation.data?.messages
    const first = messages?.[0]?.seq
    const last = messages?.at(-1)?.seq
    if (!first || !last || first <= 1) return
    const upperSeq = window.limit < 500
      ? window.upperSeq ?? last
      : Math.min(last, Math.max(first + 49, (anchorSeq ?? first) + 49))
    setWindows((prev) => ({ ...prev, [key]: { upperSeq, limit: Math.min(500, window.limit + 50) } }))
  }

  function jumpToLatest() {
    setWindows((prev) => ({ ...prev, [key]: liveWindow }))
  }

  return {
    rooms,
    selectedRoom,
    conversation: decoratedConversation,
    draft: current.draft,
    pending: current.pending,
    pendingIntent: current.pendingCommand?.intent ?? null,
    error: current.error,
    canRetry: Boolean(current.failed),
    failedText: current.failed?.text ?? null,
    window,
    freezeHistory,
    loadOlder,
    jumpToLatest,
    retryConversation: () => setWindows((prev) => ({ ...prev, [key]: { ...window } })),
    setDraft,
    send,
    retrySend,
    retryAi,
    editMessage,
    editDrafts: roomEditDrafts,
    setEditDraft,
    deleteMessage,
    deleteStates: roomDeleteStates,
    dismissDeleteState,
    isMaintenanceActive,
    maintenanceWorking,
    maintenanceError,
    resumeMaintenance,
    createRoom: (input: { name: string; description: string }) => port.createRoom(input),
    loadMoreRooms: port.loadMoreRooms ? () => port.loadMoreRooms!() : undefined,
    retryRooms: port.retryRooms ? () => port.retryRooms!() : undefined,
  }
}
