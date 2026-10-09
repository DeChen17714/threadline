import type { Firestore, DocumentSnapshot } from 'firebase/firestore'
import {
  collection,
  doc,
  documentId,
  getDocFromServer,
  Timestamp,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import type { Functions } from 'firebase/functions'
import { httpsCallable } from 'firebase/functions'
import type { Auth } from 'firebase/auth'
import type {
  Command,
  CommandResult,
  Conversation,
  DeleteMessageInput,
  EditMessageInput,
  Generation,
  Member,
  Message,
  MessageIntent,
  MessageWindow,
  ReadState,
  RetryReplyInput,
  Room,
} from '@threadline/shared'
import type { AuthUser } from './auth'
import { CommandRejectedError, CommandUncertainError, type WorkspacePort } from './workspace.ts'

function toRoom(docSnap: DocumentSnapshot): Room {
  const data = docSnap.data()
  if (!data || !(data.createdAt instanceof Timestamp) || !Array.isArray(data.members)
    || typeof data.name !== 'string' || typeof data.description !== 'string'
    || typeof data.creatorId !== 'string') throw new Error('Room data could not be read safely.')

  const latestSeq = typeof data.nextSeq === 'number' && Number.isFinite(data.nextSeq)
    ? Math.max(0, data.nextSeq - 1)
    : undefined

  const maintenanceId = typeof data.maintenanceId === 'string' && data.maintenanceId.trim().length > 0
    ? data.maintenanceId
    : null
  const maintenanceState = data.maintenanceState === 'updating-context'
    ? 'updating-context'
    : null

  return {
    id: docSnap.id,
    name: data.name,
    description: data.description,
    creatorId: data.creatorId,
    members: data.members.map((m: unknown) => {
      const memberObj = m && typeof m === 'object' ? (m as Record<string, unknown>) : {}
      return {
        uid: typeof memberObj.uid === 'string' ? memberObj.uid : '',
        label: typeof memberObj.label === 'string' ? memberObj.label : '',
      }
    }),
    createdAt: data.createdAt.toMillis(),
    ...(latestSeq !== undefined ? { latestSeq } : {}),
    maintenanceId,
    maintenanceState,
  }
}

function toMessage(docSnap: DocumentSnapshot, roomId: string): Message {
  const data = docSnap.data()
  if (!data || !Number.isSafeInteger(data.seq) || data.seq < 1
    || typeof data.text !== 'string' || !(data.createdAt instanceof Timestamp)) {
    throw new Error('Message data could not be read safely.')
  }
  const base = {
    id: docSnap.id, roomId, seq: data.seq, text: data.text,
    createdAt: data.createdAt.toMillis(),
    version: typeof data.version === 'number' ? data.version : undefined,
    editedAt: data.editedAt instanceof Timestamp ? data.editedAt.toMillis() : null,
    deletedAt: data.deletedAt instanceof Timestamp ? data.deletedAt.toMillis() : null,
  }
  if (data.kind === 'ai' && typeof data.replyToId === 'string' && typeof data.requesterLabel === 'string') {
    const contextState = data.contextState === 'stale' || data.contextState === 'current'
      ? data.contextState
      : null
    const contextReason = data.contextReason === 'earlier-version' || data.contextReason === 'earlier-context-changed' || data.contextReason === 'deleted-message'
      ? data.contextReason
      : null
    return {
      ...base,
      kind: 'ai',
      replyToId: data.replyToId,
      requesterLabel: data.requesterLabel,
      simulated: data.simulated === true,
      ...(contextState ? { contextState } : {}),
      ...(contextReason ? { contextReason } : {}),
    }
  }
  if (data.kind !== 'human' || typeof data.authorId !== 'string' || typeof data.authorLabel !== 'string'
    || !['room', 'ask-ai'].includes(data.intent)) throw new Error('Message identity could not be read safely.')
  return { ...base, kind: 'human', authorId: data.authorId, authorLabel: data.authorLabel, intent: data.intent }
}

function getThrottleMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  const details = 'details' in error && error.details && typeof error.details === 'object' ? error.details : null
  const retryAt = details && 'retryAt' in details && typeof details.retryAt === 'number' && Number.isFinite(details.retryAt) ? details.retryAt : null
  if (retryAt !== null) {
    const remainingMs = retryAt - Date.now()
    const waitSec = Math.max(1, Math.ceil(remainingMs / 1000))
    return `Message rate limit reached. Please wait ${waitSec}s before retrying.`
  }
  const detailsCode = details && 'code' in details && typeof details.code === 'string' ? details.code : ''
  if (
    code === 'resource-exhausted' ||
    code === 'functions/resource-exhausted' ||
    detailsCode === 'throttled'
  ) {
    return 'Message rate limit reached. Please wait a moment before trying again.'
  }
  return null
}

interface SafeAppErrorDetails {
  readonly code?: string
  readonly message?: string
}

function getSafeAppErrorDetails(error: unknown): SafeAppErrorDetails | null {
  if (!error || typeof error !== 'object' || !('details' in error)) return null
  const details = error.details
  if (!details || typeof details !== 'object') return null
  const code = 'code' in details && typeof details.code === 'string' ? details.code : undefined
  const message = 'message' in details && typeof details.message === 'string' ? details.message : undefined
  return { code, message }
}

function isUncertainError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error && typeof error.code === 'string' ? error.code.toLowerCase() : ''
  const message = 'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  if (
    code.includes('deadline-exceeded') ||
    code.includes('unavailable') ||
    code.includes('unknown') ||
    code.includes('internal') ||
    code.includes('network-request-failed')
  ) {
    return true
  }

  if (
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('offline') ||
    message.includes('unavailable') ||
    message.includes('internal') ||
    message.includes('uncertain')
  ) {
    return true
  }

  return false
}

export function createFirebaseWorkspace(
  db: Firestore,
  functions: Functions,
  auth: Auth,
  user: AuthUser,
): WorkspacePort {
  const expectedUid = user.uid
  const member: Member = { uid: expectedUid, label: user.label }

  const capabilities = {
    conversation: true,
    askAi: import.meta.env?.VITE_THREADLINE_AI_ENABLED === 'true',
  } as const

  const retainedRequests = new Map<string, string>()
  const retainedRetries = new Set<string>()
  const retainedEdits = new Set<string>()
  const retainedDeletions = new Set<string>()
  let prefixLimit = 25
  let roomsState: ReadState<readonly Room[]> = { status: 'loading' }
  const roomsListeners = new Set<(state: ReadState<readonly Room[]>) => void>()
  let roomsUnsubscribe: (() => void) | undefined
  let roomsEpoch = 0

  const roomListenersByRoom = new Map<string, Set<(state: ReadState<Room | null>) => void>>()
  const convListenersByRoom = new Map<string, Set<(state: ReadState<Conversation>) => void>>()
  const convEpochByRoom = new Map<string, number>()
  const ownedSubscriptions = new Set<() => void>()

  function clearConvTranscript(roomId: string) {
    convEpochByRoom.set(roomId, (convEpochByRoom.get(roomId) ?? 0) + 1)
    const convListeners = convListenersByRoom.get(roomId)
    if (convListeners) {
      for (const convNotify of convListeners) {
        convNotify({ status: 'ready', data: { messages: [], generation: null } })
      }
    }
  }


  function startRoomsQuery() {
    roomsUnsubscribe?.()
    const currentEpoch = ++roomsEpoch
    const currentLimit = prefixLimit

    const q = query(
      collection(db, 'rooms'),
      where('memberIds', 'array-contains', expectedUid),
      where('state', '==', 'active'),
      orderBy('createdAt', 'desc'),
      orderBy(documentId(), 'desc'),
      limit(currentLimit),
    )

    roomsUnsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        // UID and epoch guard
        if (auth.currentUser?.uid !== expectedUid || currentEpoch !== roomsEpoch) {
          return
        }
        // Room lists must ignore fromCache snapshots until server confirms current auth authorization
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) {
          return
        }
        const rooms: Room[] = snapshot.docs.map(toRoom)
        roomsState = { status: 'ready', data: rooms }
        for (const listener of roomsListeners) {
          listener(roomsState)
        }
      },
      (error) => {
        if (auth.currentUser?.uid !== expectedUid || currentEpoch !== roomsEpoch) {
          return
        }
        roomsState = {
          status: 'error',
          message: error.code === 'permission-denied' ? 'Room access was denied.' : 'Unable to load rooms. Check your connection and retry.',
        }
        for (const listener of roomsListeners) {
          listener(roomsState)
        }
      },
    )
  }

  function subscribeRooms(notify: (state: ReadState<readonly Room[]>) => void): () => void {
    roomsListeners.add(notify)
    notify(roomsState)
    if (roomsListeners.size === 1) {
      startRoomsQuery()
    }

    return () => {
      roomsListeners.delete(notify)
      if (roomsListeners.size === 0) {
        roomsEpoch++
        roomsUnsubscribe?.()
        roomsUnsubscribe = undefined
        roomsState = { status: 'loading' }
      }
    }
  }

  function loadMoreRooms(): void {
    if (auth.currentUser?.uid !== expectedUid) return
    prefixLimit += 25
    if (roomsListeners.size > 0) {
      startRoomsQuery()
    }
  }

  function retryRooms(): void {
    if (auth.currentUser?.uid !== expectedUid) return
    roomsState = { status: 'loading' }
    for (const listener of roomsListeners) {
      listener(roomsState)
    }
    if (roomsListeners.size > 0) {
      startRoomsQuery()
    }
  }

  function subscribeRoom(roomId: string, notify: (state: ReadState<Room | null>) => void): () => void {
    notify({ status: 'loading' })
    if (auth.currentUser?.uid !== expectedUid) {
      notify({ status: 'ready', data: null })
      return () => {}
    }

    let active = true
    let set = roomListenersByRoom.get(roomId)
    if (!set) {
      set = new Set()
      roomListenersByRoom.set(roomId, set)
    }
    set.add(notify)

    const roomRef = doc(db, 'rooms', roomId)

    const unsubscribe = onSnapshot(
      roomRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!active || auth.currentUser?.uid !== expectedUid) return
        // Server-confirmed snapshots only
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) {
          return
        }
        if (!snapshot.exists()) {
          notify({ status: 'ready', data: null })
          clearConvTranscript(roomId)
          return
        }
        const data = (snapshot.data() as Record<string, unknown> | undefined) ?? {}
        const memberIds = Array.isArray(data.memberIds) ? data.memberIds : []
        if (data.state !== 'active' || !memberIds.includes(expectedUid)) {
          notify({ status: 'ready', data: null })
          clearConvTranscript(roomId)
          return
        }
        notify({ status: 'ready', data: toRoom(snapshot) })
      },
      (error) => {
        if (!active || auth.currentUser?.uid !== expectedUid) return
        if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
          notify({ status: 'ready', data: null })
          clearConvTranscript(roomId)
        } else {
          notify({ status: 'error', message: 'Unable to load room. Check your connection and retry.' })
        }
      },
    )

    const cleanup = () => {
      active = false
      unsubscribe()
      ownedSubscriptions.delete(cleanup)
      const currentSet = roomListenersByRoom.get(roomId)
      if (currentSet) {
        currentSet.delete(notify)
        if (currentSet.size === 0) {
          roomListenersByRoom.delete(roomId)
        }
      }
    }
    ownedSubscriptions.add(cleanup)
    return cleanup
  }

  function subscribeConversation(
    roomId: string,
    notify: (state: ReadState<Conversation>) => void,
    window: MessageWindow,
  ): () => void {
    if (typeof notify !== 'function') {
      throw new Error('Notification callback must be a function.')
    }
    if (!window || typeof window !== 'object') {
      throw new Error('Message window options must be an object.')
    }
    const { upperSeq, limit: windowLimit } = window
    if (upperSeq !== null && (!Number.isSafeInteger(upperSeq) || upperSeq < 1)) {
      throw new Error('Message window upperSeq must be null or a positive integer.')
    }
    if (!Number.isSafeInteger(windowLimit) || windowLimit < 50 || windowLimit > 500) {
      throw new Error('Message window limit must be an integer between 50 and 500.')
    }

    if (!roomId) {
      notify({ status: 'ready', data: { messages: [], generation: null } })
      return () => {}
    }

    notify({ status: 'loading' })
    if (auth.currentUser?.uid !== expectedUid) {
      notify({ status: 'ready', data: { messages: [], generation: null } })
      return () => {}
    }

    let active = true
    let settled = false
    let messages: readonly Message[] = []
    let messagesReady = false
    let generationReady = false
    let roomReady = false
    let promptReady = true

    let latestGenData: Record<string, unknown> | null = null
    let latestGenId: string | null = null
    let latestRoomData: Record<string, unknown> | null = null
    let latestPromptData: Record<string, unknown> | null = null

    let observedPromptId: string | null = null
    let promptUnsubscribe: (() => void) | undefined

    let expiryTimer: number | undefined
    const recovered = new Set<string>()

    function computeGeneration(): Generation | null {
      if (!latestGenData) return null
      const data = latestGenData
      if (data.state === 'succeeded' || data.state === 'cancelled') return null

      if (
        typeof data.promptMessageId !== 'string' ||
        typeof data.requesterLabel !== 'string' ||
        typeof data.expiresAt !== 'number' ||
        typeof data.requesterId !== 'string'
      ) {
        return null
      }

      const isPending = ['preparing', 'dispatched'].includes(data.state as string)
      const isExpired = (data.expiresAt as number) <= Date.now()
      const pending = isPending && !isExpired

      if (pending) {
        return {
          id: latestGenId ?? undefined,
          promptMessageId: data.promptMessageId as string,
          requesterId: data.requesterId as string,
          requesterLabel: data.requesterLabel as string,
          expiresAt: data.expiresAt as number,
          state: 'pending',
          canRetry: false,
        }
      }

      const isMember =
        latestRoomData?.state === 'active' &&
        Array.isArray(latestRoomData.memberIds) &&
        latestRoomData.memberIds.includes(expectedUid)
      const isAuthor = data.requesterId === expectedUid
      const hasActiveFence = Boolean(latestRoomData?.activeGenerationId)
      const inMaintenance = Boolean(latestRoomData?.maintenanceId)
      const isLatestGen = latestRoomData?.latestGenerationId === latestGenId
      const isLatestAsk = latestRoomData?.latestAiPromptId === data.promptMessageId
      const promptAlive = Boolean(latestPromptData && latestPromptData.kind === 'human' && latestPromptData.intent === 'ask-ai' && !latestPromptData.deletedAt)
      const promptAuthorMatch = latestPromptData?.authorId === expectedUid
      const versionMatches = Number.isSafeInteger(data.promptVersion) && (data.promptVersion as number) > 0
        && latestPromptData?.version === data.promptVersion

      let canRetry = false
      let retryIneligibleReason: string | undefined

      if (latestRoomData) {
        if (!['failed', 'timed-out'].includes(data.state as string)) {
          retryIneligibleReason = 'Reply status needs reconfirming. Reconnect to recover it.'
        } else if (!isMember) {
          retryIneligibleReason = 'You are not an active member of this room.'
        } else if (!isAuthor) {
          retryIneligibleReason = 'Only the author of the question can retry this reply.'
        } else if (inMaintenance) {
          retryIneligibleReason = 'Conversation context is being updated. Please wait.'
        } else if (hasActiveFence) {
          retryIneligibleReason = 'A reply is currently in progress.'
        } else if (!isLatestAsk) {
          retryIneligibleReason = 'A newer question was asked in this room.'
        } else if (!isLatestGen) {
          retryIneligibleReason = 'A newer reply was already started.'
        } else if (promptReady && !promptAlive) {
          retryIneligibleReason = 'The original question was deleted.'
        } else if (promptReady && !versionMatches) {
          retryIneligibleReason = 'The original question was edited.'
        } else if (promptReady && !promptAuthorMatch) {
          retryIneligibleReason = 'Only the author of the question can retry this reply.'
        } else if (promptReady) {
          canRetry = true
        }
      }

      return {
        id: latestGenId ?? undefined,
        promptMessageId: data.promptMessageId as string,
        requesterId: data.requesterId as string,
        requesterLabel: data.requesterLabel as string,
        expiresAt: data.expiresAt as number,
        state: 'failed',
        canRetry,
        ...(retryIneligibleReason ? { retryIneligibleReason } : {}),
        ...(typeof data.errorCode === 'string' ? { errorCode: data.errorCode } : {}),
      }
    }

    const emit = () => {
      if (!active || !messagesReady || !generationReady || !roomReady || !promptReady
        || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)) return
      if (!settled) {
        settled = true
        clearTimeout(coldLoadTimer)
        coldLoadTimer = undefined
      }
      notify({ status: 'ready', data: { messages, generation: computeGeneration() } })
    }

    const updatePromptObserver = (targetPromptId: string | null) => {
      if (observedPromptId === targetPromptId) return
      promptUnsubscribe?.()
      promptUnsubscribe = undefined
      observedPromptId = targetPromptId
      latestPromptData = null

      if (!targetPromptId) {
        promptReady = true
        emit()
        return
      }

      promptReady = false
      const promptRef = doc(db, 'rooms', roomId, 'messages', targetPromptId)
      promptUnsubscribe = onSnapshot(
        promptRef,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (!active || observedPromptId !== targetPromptId || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)) return
          if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return
          promptReady = true
          latestPromptData = snapshot.exists() ? (snapshot.data() as Record<string, unknown>) : null
          emit()
        },
        (error) => {
          if (!active || observedPromptId !== targetPromptId || currentEpoch !== convEpochByRoom.get(roomId) || auth.currentUser?.uid !== expectedUid) return
          if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
            clearConvTranscript(roomId)
            cleanup()
            const roomListeners = roomListenersByRoom.get(roomId)
            if (roomListeners) {
              for (const roomNotify of roomListeners) roomNotify({ status: 'ready', data: null })
            }
          }
          else {
            promptReady = false
            settled = true
            clearTimeout(coldLoadTimer)
            notify({ status: 'error', message: 'Unable to confirm the question. Retry loading the conversation.' })
          }
        },
      )
    }

    const currentEpoch = (convEpochByRoom.get(roomId) ?? 0) + 1
    convEpochByRoom.set(roomId, currentEpoch)

    let set = convListenersByRoom.get(roomId)
    if (!set) {
      set = new Set()
      convListenersByRoom.set(roomId, set)
    }
    set.add(notify)

    let coldLoadTimer: number | undefined = setTimeout(() => {
      if (!active || settled || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)) return
      settled = true
      notify({
        status: 'error',
        message: 'Unable to load conversation. Check your connection and retry.',
      })
    }, 10_000)

    const messagesRef = collection(db, 'rooms', roomId, 'messages')
    const q = upperSeq === null
      ? query(
          messagesRef,
          orderBy('seq', 'desc'),
          limit(windowLimit),
        )
      : query(
          messagesRef,
          where('seq', '<=', upperSeq),
          orderBy('seq', 'desc'),
          limit(windowLimit),
        )

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!active || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)) return
        // Server-authorized snapshots only: ignore cache or pending writes
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) {
          return
        }
        try {
          messages = snapshot.docs.map((row) => toMessage(row, roomId)).reverse()
          messagesReady = true
          emit()
        } catch {
          notify({ status: 'error', message: 'Conversation data could not be read safely. Retry loading messages.' })
        }
      },
      (error) => {
        if (!active || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)) return
        settled = true
        clearTimeout(coldLoadTimer)
        coldLoadTimer = undefined

        if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
          clearConvTranscript(roomId)
          cleanup()
          const roomListeners = roomListenersByRoom.get(roomId)
          if (roomListeners) {
            for (const roomNotify of roomListeners) roomNotify({ status: 'ready', data: null })
          }
        } else {
          notify({ status: 'error', message: 'Unable to load conversation. Check your connection and retry.' })
        }
      },
     )
    const generationUnsubscribe = onSnapshot(
      query(collection(db, 'rooms', roomId, 'generations'), orderBy('startedAt', 'desc'), limit(1)),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!active || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)
          || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return
        clearTimeout(expiryTimer)
        generationReady = true
        const row = snapshot.docs[0]
        const data = row?.data()
        latestGenId = row?.id ?? null
        latestGenData = data ? (data as Record<string, unknown>) : null
        const promptId = typeof data?.promptMessageId === 'string' ? data.promptMessageId : null
        updatePromptObserver(promptId)

        if (data && typeof data.expiresAt === 'number') {
          const isPending = ['preparing', 'dispatched'].includes(data.state)
          const isExpired = data.expiresAt <= Date.now()
          const pending = isPending && !isExpired
          if (pending) {
            const delay = Math.max(0, data.expiresAt - Date.now()) + 50
            expiryTimer = setTimeout(() => {
              if (!active || currentEpoch !== convEpochByRoom.get(roomId) || auth.currentUser?.uid !== expectedUid) return
              emit()
              if ((typeof navigator !== 'undefined' && !navigator.onLine) || recovered.has(row.id)) return
              recovered.add(row.id)
              void httpsCallable<Command, CommandResult>(functions, 'command')({ requestId: crypto.randomUUID(),
                operation: 'recoverGeneration', input: { roomId, generationId: row.id } }).catch(() => {})
            }, delay)
          } else if (isPending && isExpired) {
            if (typeof navigator === 'undefined' || navigator.onLine) {
              if (!recovered.has(row.id)) {
                recovered.add(row.id)
                void httpsCallable<Command, CommandResult>(functions, 'command')({ requestId: crypto.randomUUID(),
                  operation: 'recoverGeneration', input: { roomId, generationId: row.id } }).catch(() => {})
              }
            }
          }
        }
        emit()
      },
      (error) => {
        if (!active || currentEpoch !== convEpochByRoom.get(roomId) || auth.currentUser?.uid !== expectedUid) return
        settled = true
        clearTimeout(coldLoadTimer)
        coldLoadTimer = undefined
        if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
          clearConvTranscript(roomId)
          cleanup()
          const roomListeners = roomListenersByRoom.get(roomId)
          if (roomListeners) {
            for (const roomNotify of roomListeners) roomNotify({ status: 'ready', data: null })
          }
        } else {
          notify({ status: 'error', message: 'Unable to confirm AI status. Check your connection and retry.' })
        }
      },
    )

    const roomRef = doc(db, 'rooms', roomId)
    const roomUnsubscribe = onSnapshot(
      roomRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!active || auth.currentUser?.uid !== expectedUid || currentEpoch !== convEpochByRoom.get(roomId)) return
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return
        roomReady = true
        if (!snapshot.exists()) {
          latestRoomData = null
          clearConvTranscript(roomId)
          cleanup()
          notify({ status: 'ready', data: { messages: [], generation: null } })
          return
        }
        const data = (snapshot.data() as Record<string, unknown> | undefined) ?? {}
        const memberIds = Array.isArray(data.memberIds) ? data.memberIds : []
        if (data.state !== 'active' || !memberIds.includes(expectedUid)) {
          latestRoomData = null
          clearConvTranscript(roomId)
          cleanup()
          notify({ status: 'ready', data: { messages: [], generation: null } })
          return
        }
        latestRoomData = data
        emit()
      },
      (error) => {
        if (!active || currentEpoch !== convEpochByRoom.get(roomId) || auth.currentUser?.uid !== expectedUid) return
        if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
          clearConvTranscript(roomId)
          cleanup()
          const roomListeners = roomListenersByRoom.get(roomId)
          if (roomListeners) {
            for (const roomNotify of roomListeners) roomNotify({ status: 'ready', data: null })
          }
        }
        else {
          roomReady = false
          settled = true
          clearTimeout(coldLoadTimer)
          notify({ status: 'error', message: 'Unable to confirm room access. Retry loading the conversation.' })
        }
      },
    )

    const cleanup = () => {
      active = false
      messages = []
      latestGenData = null
      latestGenId = null
      latestRoomData = null
      latestPromptData = null
      observedPromptId = null
      messagesReady = false
      generationReady = false
      roomReady = false
      promptReady = false
      clearTimeout(coldLoadTimer)
      coldLoadTimer = undefined
      unsubscribe()
      generationUnsubscribe()
      roomUnsubscribe()
      if (promptUnsubscribe) {
        promptUnsubscribe()
        promptUnsubscribe = undefined
      }
      clearTimeout(expiryTimer)
      expiryTimer = undefined
      ownedSubscriptions.delete(cleanup)
      const currentSet = convListenersByRoom.get(roomId)
      if (currentSet) {
        currentSet.delete(notify)
        if (currentSet.size === 0) convListenersByRoom.delete(roomId)
      }
    }
    ownedSubscriptions.add(cleanup)
    return cleanup
  }

  async function createRoom(input: { name: string; description: string }): Promise<Room> {
    const requireAccount = () => {
      if (auth.currentUser?.uid !== expectedUid) {
        retainedRequests.clear()
        throw new Error('Account changed; room creation cancelled.')
      }
    }
    requireAccount()
    const payload = { name: input.name.trim(), description: input.description.trim() }
    if (!payload.name || payload.name.length > 80 || input.description.length > 500) throw new Error('Use a name of 1–80 characters and a description of at most 500.')
    const key = JSON.stringify(payload)
    const previous = retainedRequests.get(key)
    const requestId = previous ?? crypto.randomUUID()
    retainedRequests.set(key, requestId)
    const command = httpsCallable<Command, CommandResult>(functions, 'command')
    const callCommand = async (body: Command): Promise<CommandResult> => {
      try {
        return (await command(body)).data
      } catch (error) {
        requireAccount()
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        // A missing receipt permits the existing idempotent submission path.
        if (body.operation === 'getOperation' && code === 'functions/not-found') throw error
        const details = getSafeAppErrorDetails(error)
        if (details?.code && ['validation', 'forbidden', 'unauthenticated', 'room-busy', 'conflict', 'throttled'].includes(details.code)) {
          throw new CommandRejectedError(details.message ?? 'Room creation was rejected. Check your details and try again.', { cause: error })
        }
        if (code === 'functions/unauthenticated') {
          throw new CommandRejectedError('Sign in again to create a room.', { cause: error })
        }
        if (code === 'functions/permission-denied') {
          throw new CommandRejectedError('Room creation was denied. Check your sign-in and app access.', { cause: error })
        }
        if (isUncertainError(error) || code === 'functions/not-found') {
          throw new CommandUncertainError('Room creation could not be confirmed. The server may be unavailable. Your details are kept; please retry.', { cause: error })
        }
        throw new Error('Unable to create the room. Please try again.', { cause: error })
      }
    }
    let result: CommandResult | undefined
    if (previous) {
      try {
        requireAccount()
        result = await callCommand({ requestId: crypto.randomUUID(), operation: 'getOperation',
          input: { operationId: `${expectedUid}_createRoom_${requestId}` } })
        requireAccount()
      } catch (error) {
        requireAccount()
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'functions/not-found') throw error
      }
      requireAccount()
    }
    if (!result) {
      requireAccount()
      result = await callCommand({ requestId, operation: 'createRoom', input: payload })
      requireAccount()
    }
    if (result.status !== 'complete' || !result.roomId) throw new Error('Room creation is not confirmed. Retry to check its saved status.')
    requireAccount()
    const room = await getDocFromServer(doc(db, 'rooms', result.roomId))
    requireAccount()
    if (!room.exists() || room.data().state !== 'active' || !room.data().memberIds.includes(expectedUid)) throw new Error('Room is no longer available.')
    retainedRequests.delete(key)
    return toRoom(room)
  }

  async function send(input: {
    requestId: string
    roomId: string
    messageId: string
    text: string
    intent: MessageIntent
  }): Promise<void> {
    const requireAccount = () => {
      if (auth.currentUser?.uid !== expectedUid) {
        throw new Error('Account changed; send cancelled.')
      }
    }

    requireAccount()


    const trimmed = input.text.trim()
    if (!trimmed || input.text.length > 4000 || new TextEncoder().encode(input.text).length > 16384) {
      throw new Error('Message must be 1–4000 characters and at most 16 KiB.')
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('Send status is uncertain. You are offline; check your connection and retry.')
    }

    const command = httpsCallable<Command, CommandResult>(functions, 'command', { timeout: 90000 })

    const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>()
    const timerId = setTimeout(() => rejectTimeout(new Error(
      'Send status is uncertain. Request timed out; retry to confirm delivery.',
    )), 15_000)

    let result: CommandResult
    try {
      requireAccount()
      const callPromise = command({
        requestId: input.requestId,
        operation: input.intent === 'ask-ai' ? 'askThreadline' : 'sendRoomMessage',
        input: {
          roomId: input.roomId,
          messageId: input.messageId,
          text: input.text,
        },
      })
      const response = await Promise.race([callPromise, timeoutPromise])
      clearTimeout(timerId)
      requireAccount()
      result = response.data
    } catch (error) {
      clearTimeout(timerId)
      requireAccount()

      const throttleMsg = input.intent === 'room' ? getThrottleMessage(error) : null
      if (throttleMsg) {
        throw new CommandRejectedError(throttleMsg, { cause: error })
      }

      const details = getSafeAppErrorDetails(error)
      if (details?.code && ['validation', 'forbidden', 'unauthenticated', 'room-busy', 'budget-exhausted', 'conflict', 'throttled', 'provider-unavailable'].includes(details.code)) {
        throw new CommandRejectedError(details.message ?? 'This request was rejected. Your draft is retained.', { cause: error })
      }

      if (isUncertainError(error)) {
        throw new Error('Send status is uncertain. Check your connection or retry to confirm.', { cause: error })
      }

      if (error instanceof Error) {
        throw error
      }
      throw new Error('Unable to send message.', { cause: error })
    }

    requireAccount()

    if (input.intent === 'room' && result.status !== 'complete') {
      throw new Error('Send status is uncertain. Message delivery is not confirmed; retry to confirm.')
    }
  }

  async function retryReply(input: RetryReplyInput): Promise<void> {
    const requireAccount = () => {
      if (auth.currentUser?.uid !== expectedUid) {
        retainedRetries.clear()
        throw new Error('Account changed; retry cancelled.')
      }
    }
    requireAccount()

    if (!input || typeof input !== 'object') {
      throw new Error('Retry input must be an object.')
    }
    const { requestId, roomId, promptMessageId, generationId } = input
    if (
      typeof requestId !== 'string' || !requestId ||
      typeof roomId !== 'string' || !roomId ||
      typeof promptMessageId !== 'string' || !promptMessageId ||
      typeof generationId !== 'string' || !generationId
    ) {
      throw new Error('All retry identifiers (requestId, roomId, promptMessageId, generationId) are required.')
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new CommandUncertainError('Retry status is uncertain. You are offline; check your connection and retry.')
    }

    const retryKey = `${roomId}/${generationId}/${requestId}`
    const previous = retainedRetries.has(retryKey)
    retainedRetries.add(retryKey)

    const command = httpsCallable<Command, CommandResult>(functions, 'command', { timeout: 90000 })
    const callBounded = async (body: Command): Promise<CommandResult> => {
      const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>()
      const timerId = setTimeout(() => rejectDeadline(new CommandUncertainError(
        'Retry status is uncertain. Request timed out; retry to confirm delivery.',
      )), 15_000)
      try {
        requireAccount()
        const response = await Promise.race([command(body), deadline])
        requireAccount()
        return response.data
      } catch (error) {
        requireAccount()
        if (error instanceof CommandUncertainError) throw error
        const details = getSafeAppErrorDetails(error)
        if (details?.code && ['validation', 'forbidden', 'unauthenticated', 'room-busy', 'budget-exhausted', 'conflict', 'throttled', 'provider-unavailable'].includes(details.code)) {
          throw new CommandRejectedError(details.message ?? 'This retry request was rejected.', { cause: error })
        }
        if (isUncertainError(error)) {
          throw new CommandUncertainError('Retry status is uncertain. Check your connection or retry to confirm.', { cause: error })
        }
        if (error instanceof Error) throw error
        throw new Error('Unable to retry reply.', { cause: error })
      } finally {
        clearTimeout(timerId)
      }
    }

    let result: CommandResult | undefined
    if (previous) {
      try {
        result = await callBounded({
          requestId: crypto.randomUUID(), operation: 'getOperation',
          input: { operationId: `${expectedUid}_retryAiReply_${requestId}` },
        })
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'functions/not-found') throw error
      }
    }
    if (!result) {
      result = await callBounded({
        requestId, operation: 'retryAiReply', input: { roomId, promptMessageId, generationId },
      })
    }

    requireAccount()
    if (result.status === 'cancelled') {
      throw new CommandRejectedError('The retry was cancelled.')
    }
    if (result.status === 'failed') {
      throw new CommandRejectedError('The retry attempt failed. Check the error in conversation.')
    }
  }

  async function editMessage(input: EditMessageInput): Promise<CommandResult> {
    const requireAccount = () => {
      if (auth.currentUser?.uid !== expectedUid) {
        retainedEdits.clear()
        throw new Error('Account changed; edit cancelled.')
      }
    }
    requireAccount()

    if (!input || typeof input !== 'object') {
      throw new Error('Edit input must be an object.')
    }
    const { requestId, roomId, messageId, expectedVersion, text } = input
    if (
      typeof requestId !== 'string' || !requestId ||
      typeof roomId !== 'string' || !roomId ||
      typeof messageId !== 'string' || !messageId ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      typeof text !== 'string'
    ) {
      throw new Error('All edit identifiers and expected version are required.')
    }

    const trimmed = text.trim()
    if (!trimmed || text.length > 4000 || new TextEncoder().encode(text).length > 16384) {
      throw new Error('Use at most 4,000 characters (16 KiB). Your draft has not been saved.')
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new CommandUncertainError('Edit status is uncertain. You are offline; check your connection and retry.')
    }

    const editKey = `${roomId}/${messageId}/${requestId}`
    const previous = retainedEdits.has(editKey)
    retainedEdits.add(editKey)

    const command = httpsCallable<Command, CommandResult>(functions, 'command', { timeout: 90000 })
    const callBounded = async (body: Command): Promise<CommandResult> => {
      const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>()
      const timerId = setTimeout(() => rejectDeadline(new CommandUncertainError(
        'Edit status is uncertain. Request timed out; retry to confirm saved state.',
      )), 15_000)
      try {
        requireAccount()
        const response = await Promise.race([command(body), deadline])
        requireAccount()
        return response.data
      } catch (error) {
        requireAccount()
        if (error instanceof CommandUncertainError) throw error
        const details = getSafeAppErrorDetails(error)
        if (details?.code && ['validation', 'forbidden', 'unauthenticated', 'room-busy', 'budget-exhausted', 'conflict', 'throttled', 'provider-unavailable'].includes(details.code)) {
          throw new CommandRejectedError(details.message ?? 'This edit request was rejected. Your draft is retained.', { cause: error })
        }
        if (isUncertainError(error)) {
          throw new CommandUncertainError('Edit status is uncertain. Check your connection or retry to confirm.', { cause: error })
        }
        if (error instanceof Error) throw error
        throw new Error('Unable to edit message.', { cause: error })
      } finally {
        clearTimeout(timerId)
      }
    }

    let result: CommandResult | undefined
    if (previous) {
      try {
        result = await callBounded({
          requestId: crypto.randomUUID(), operation: 'getOperation',
          input: { operationId: `${expectedUid}_editMessage_${requestId}` },
        })
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'functions/not-found') throw error
      }
    }
    if (!result) {
      result = await callBounded({
        requestId,
        operation: 'editMessage',
        input: { roomId, messageId, expectedVersion, text },
      })
    }

    requireAccount()
    if (result.status === 'cancelled') {
      throw new CommandRejectedError('The edit was cancelled.')
    }
    if (result.status === 'failed') {
      throw new CommandRejectedError('The edit attempt failed.')
    }
    retainedEdits.delete(editKey)
    return result
  }

  async function deleteMessage(input: DeleteMessageInput): Promise<CommandResult> {
    const requireAccount = () => {
      if (auth.currentUser?.uid !== expectedUid) {
        retainedDeletions.clear()
        throw new Error('Account changed; deletion cancelled.')
      }
    }
    requireAccount()

    if (!input || typeof input !== 'object') {
      throw new Error('Delete input must be an object.')
    }
    const { requestId, roomId, messageId, expectedVersion } = input
    if (
      typeof requestId !== 'string' || !requestId ||
      typeof roomId !== 'string' || !roomId ||
      typeof messageId !== 'string' || !messageId ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    ) {
      throw new Error('All delete identifiers and expected version are required.')
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new CommandUncertainError('Delete status is uncertain. You are offline; check your connection and retry.')
    }

    const deleteKey = `${roomId}/${messageId}/${requestId}`
    const previous = retainedDeletions.has(deleteKey)
    retainedDeletions.add(deleteKey)

    const command = httpsCallable<Command, CommandResult>(functions, 'command', { timeout: 90000 })
    const callBounded = async (body: Command): Promise<CommandResult> => {
      const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>()
      const timerId = setTimeout(() => rejectDeadline(new CommandUncertainError(
        'Delete status is uncertain. Request timed out; retry to confirm deleted state.',
      )), 15_000)
      try {
        requireAccount()
        const response = await Promise.race([command(body), deadline])
        requireAccount()
        return response.data
      } catch (error) {
        requireAccount()
        if (error instanceof CommandUncertainError) throw error
        const details = getSafeAppErrorDetails(error)
        if (details?.code && ['validation', 'forbidden', 'unauthenticated', 'room-busy', 'budget-exhausted', 'conflict', 'throttled', 'provider-unavailable'].includes(details.code)) {
          throw new CommandRejectedError(details.message ?? 'This delete request was rejected.', { cause: error })
        }
        if (isUncertainError(error)) {
          throw new CommandUncertainError('Delete status is uncertain. Check your connection or retry to confirm.', { cause: error })
        }
        if (error instanceof Error) throw error
        throw new Error('Unable to delete message.', { cause: error })
      } finally {
        clearTimeout(timerId)
      }
    }

    let result: CommandResult | undefined
    if (previous) {
      try {
        result = await callBounded({
          requestId: crypto.randomUUID(), operation: 'getOperation',
          input: { operationId: `${expectedUid}_deleteMessage_${requestId}` },
        })
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'functions/not-found') throw error
      }
    }
    if (!result) {
      result = await callBounded({
        requestId,
        operation: 'deleteMessage',
        input: { roomId, messageId, expectedVersion },
      })
    }

    requireAccount()
    if (result.status === 'cancelled') {
      throw new CommandRejectedError('The deletion was cancelled.')
    }
    if (result.status === 'failed') {
      throw new CommandRejectedError('The deletion attempt failed.')
    }
    retainedDeletions.delete(deleteKey)
    return result
  }

  async function resumeMaintenance(operationId: string): Promise<CommandResult> {
    const requireAccount = () => {
      if (auth.currentUser?.uid !== expectedUid) {
        throw new Error('Account changed; maintenance action cancelled.')
      }
    }
    requireAccount()
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new CommandUncertainError('Maintenance status is uncertain. You are offline; check your connection and retry.')
    }
    const command = httpsCallable<Command, CommandResult>(functions, 'command', { timeout: 15000 })
    const result = await command({
      requestId: crypto.randomUUID(),
      operation: 'resumeMaintenance',
      input: { operationId },
    })
    requireAccount()
    return result.data
  }

  function dispose(): void {
    roomsEpoch++
    roomsListeners.clear()
    roomsUnsubscribe?.()
    roomsUnsubscribe = undefined

    for (const unsub of ownedSubscriptions) {
      unsub()
    }
    ownedSubscriptions.clear()
    roomListenersByRoom.clear()
    convListenersByRoom.clear()
    convEpochByRoom.clear()
    retainedRequests.clear()
    retainedRetries.clear()
    retainedEdits.clear()
    retainedDeletions.clear()
    roomsState = { status: 'loading' }
  }

  return {
    member,
    capabilities,
    subscribeRooms,
    subscribeRoom,
    loadMoreRooms,
    retryRooms,
    dispose,
    subscribeConversation,
    createRoom,
    send,
    retryReply,
    editMessage,
    deleteMessage,
    resumeMaintenance,
  }
}
