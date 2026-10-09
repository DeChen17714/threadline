import type { CommandResult, Conversation, DeleteMessageInput, EditMessageInput, HumanMessage, Member, Message, MessageWindow, ReadState, Room } from '@threadline/shared'
import { CommandRejectedError, type PreviewControls, type PreviewScenario, type WorkspacePort } from './workspace'

const previewMember: Member = { uid: 'preview-wong', label: 'Wong (preview)' }
const maya: Member = { uid: 'preview-maya', label: 'Maya (preview)' }
const startTime = Date.UTC(2026, 9, 7, 9)
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

export class DemoWorkspace implements WorkspacePort, PreviewControls {
  readonly member = previewMember
  readonly capabilities = { conversation: true, askAi: true } as const
  scenario: PreviewScenario = 'normal'
  private counter = 0
  private rooms: readonly Room[] = [
    { id: 'design-ideas', name: 'Design ideas', description: 'A shared space to think through the next idea.', creatorId: previewMember.uid, members: [previewMember, maya], createdAt: startTime },
    { id: 'weekend-plans', name: 'Weekend plans', description: 'A little room for a change of scenery.', creatorId: previewMember.uid, members: [previewMember], createdAt: startTime - 1000 },
    { id: 'learning-notes', name: 'Learning notes', description: '', creatorId: previewMember.uid, members: [previewMember], createdAt: startTime - 2000 },
  ]
  private conversations = new Map<string, Conversation>([
    ['design-ideas', { messages: [
      { id: 'intro', roomId: 'design-ideas', seq: 1, kind: 'human', authorId: previewMember.uid, authorLabel: previewMember.label, intent: 'ask-ai', text: 'Help me turn this idea into a clear plan.', createdAt: startTime },
      { id: 'intro-answer', roomId: 'design-ideas', seq: 2, kind: 'ai', simulated: true, replyToId: 'intro', requesterLabel: previewMember.label, text: 'Start with **one clear outcome**.\n\n1. Define what success looks like.\n2. Break it into small steps.\n3. Choose your first move.\n\nThis is a prewritten preview answer, not a model response.', createdAt: startTime + 1000 },
      { id: 'maya-note', roomId: 'design-ideas', seq: 3, kind: 'human', authorId: maya.uid, authorLabel: maya.label, intent: 'room', text: 'Let’s keep a useful example here:\n\n```ts\nconst conversation = { room: "Design ideas", members: ["Wong", "Maya"], purpose: "Keep useful context together without losing the earlier discussion" };\n```\n\n[Read about Markdown](https://commonmark.org/). Images and raw HTML are not rendered.', createdAt: startTime + 2000 },
    ], generation: null }],
    ['weekend-plans', { messages: [{ id: 'weekend-intro', roomId: 'weekend-plans', seq: 1, kind: 'human', authorId: previewMember.uid, authorLabel: previewMember.label, intent: 'room', text: 'A morning walk, then somewhere quiet for lunch?', createdAt: startTime }], generation: null }],
    ['learning-notes', { messages: [], generation: null }],
  ])
  private roomListeners = new Set<(state: ReadState<readonly Room[]>) => void>()
  private conversationListeners = new Map<string, Set<(state: ReadState<Conversation>) => void>>()
  private singleRoomListeners = new Map<string, Set<(state: ReadState<Room | null>) => void>>()

  setScenario(scenario: PreviewScenario) {
    this.scenario = scenario
    this.emitRooms()
    for (const id of this.conversationListeners.keys()) this.emitConversation(id)
    for (const id of this.singleRoomListeners.keys()) this.emitSingleRoom(id)
  }

  subscribeRooms(notify: (state: ReadState<readonly Room[]>) => void) {
    notify({ status: 'loading' })
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      this.roomListeners.add(notify)
      notify(this.roomState())
    }, 300)
    return () => { active = false; window.clearTimeout(timer); this.roomListeners.delete(notify) }
  }
  subscribeRoom(roomId: string, notify: (state: ReadState<Room | null>) => void) {
    notify({ status: 'loading' })
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      const listeners = this.singleRoomListeners.get(roomId) ?? new Set()
      listeners.add(notify)
      this.singleRoomListeners.set(roomId, listeners)
      notify(this.singleRoomState(roomId))
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
      const listeners = this.singleRoomListeners.get(roomId)
      listeners?.delete(notify)
      if (listeners?.size === 0) this.singleRoomListeners.delete(roomId)
    }
  }

  retryRooms() {
    if (this.scenario === 'read-error') {
      this.setScenario('normal')
    }
  }


  dispose() {
    this.roomListeners.clear()
    this.singleRoomListeners.clear()
    this.conversationListeners.clear()
  }

  subscribeConversation(roomId: string, notify: (state: ReadState<Conversation>) => void, messageWindow: MessageWindow) {
    const notifyWindow = (state: ReadState<Conversation>) => {
      if (state.status !== 'ready') { notify(state); return }
      const messages = state.data.messages.filter((message) => messageWindow.upperSeq === null || message.seq <= messageWindow.upperSeq).slice(-messageWindow.limit)
      notify({ status: 'ready', data: { ...state.data, messages } })
    }
    notify({ status: 'loading' })
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      const listeners = this.conversationListeners.get(roomId) ?? new Set()
      listeners.add(notifyWindow)
      this.conversationListeners.set(roomId, listeners)
      notifyWindow(this.conversationState(roomId))
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
      const listeners = this.conversationListeners.get(roomId)
      listeners?.delete(notifyWindow)
      if (listeners?.size === 0) this.conversationListeners.delete(roomId)
    }
  }

  async createRoom({ name, description }: { name: string; description: string }) {
    const trimmed = name.trim()
    if (this.scenario === 'empty') this.scenario = 'normal'
    if (!trimmed || trimmed.length > 80 || description.length > 500) throw new Error('Use a room name of 1–80 characters and a description of at most 500 characters.')
    await wait(350)
    if (this.scenario === 'create-error') {
      this.scenario = 'normal'
      throw new Error('Simulated room creation failure. Your entries are preserved; try again.')
    }
    const room: Room = { id: `preview-room-${++this.counter}`, name: trimmed, description: description.trim(), creatorId: this.member.uid, members: [this.member], createdAt: startTime + this.counter * 1000 }
    this.rooms = [room, ...this.rooms]
    this.conversations.set(room.id, { messages: [], generation: null })
    this.emitRooms()
    return room
  }

  async send({ roomId, messageId, text, intent }: Parameters<WorkspacePort['send']>[0]) {
    if (this.scenario === 'empty') this.scenario = 'normal'
    if (!text.trim() || text.length > 4000 || new TextEncoder().encode(text).length > 16384) throw new Error('Enter a message of up to 4,000 characters (16 KiB).')
    this.requireConversation(roomId)
    await wait(250)
    if (this.scenario === 'send-error') {
      this.scenario = 'normal'
      throw new Error('Simulated send failure. Your draft is preserved; try again.')
    }
    const current = this.requireConversation(roomId)
    if (current.messages.some((message) => message.id === messageId)) return
    if (intent === 'ask-ai' && current.generation?.state === 'pending') throw new Error('Threadline is already demonstrating a reply in this room. You can still send to the room.')
    const genId = `00000000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`
    const message: HumanMessage = { id: messageId, roomId, seq: (current.messages.at(-1)?.seq ?? 0) + 1, text, kind: 'human', authorId: this.member.uid, authorLabel: this.member.label, intent, createdAt: startTime + (++this.counter + 10) * 1000 }
    this.conversations.set(roomId, { messages: [...current.messages, message], generation: intent === 'ask-ai' ? { id: genId, state: 'pending', promptMessageId: messageId, requesterId: this.member.uid, requesterLabel: this.member.label, simulated: true, canRetry: false } : current.generation })
    this.emitConversation(roomId)
    if (intent === 'ask-ai') void this.finishReply(roomId, messageId)
  }

  async retryReply({ roomId, promptMessageId, generationId }: Parameters<WorkspacePort['retryReply']>[0]) {
    const current = this.requireConversation(roomId)
    const prompt = current.messages.find((m) => m.id === promptMessageId)
    if (
      current.generation?.state !== 'failed' ||
      current.generation.id !== generationId ||
      current.generation.promptMessageId !== promptMessageId ||
      !prompt ||
      prompt.kind !== 'human' ||
      prompt.authorId !== this.member.uid ||
      prompt.deletedAt != null
    ) {
      throw new Error('This preview reply cannot be retried.')
    }
    const nextGenId = `00000000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`
    this.conversations.set(roomId, { ...current, generation: { ...current.generation, id: nextGenId, state: 'pending', canRetry: false } })
    this.emitConversation(roomId)
    void this.finishReply(roomId, promptMessageId)
  }

  async editMessage(input: EditMessageInput): Promise<CommandResult> {
    const trimmed = input.text.trim()
    if (!trimmed || input.text.length > 4000 || new TextEncoder().encode(input.text).length > 16384) {
      throw new Error('Enter a message of up to 4,000 characters (16 KiB).')
    }
    const current = this.requireConversation(input.roomId)
    const room = this.rooms.find((r) => r.id === input.roomId)
    if (room?.maintenanceId) {
      throw new CommandRejectedError('Updating conversation context. Edits are paused.')
    }
    if (current.generation?.state === 'pending') {
      throw new CommandRejectedError('A reply is currently in progress. Message edits are paused.')
    }
    const target = current.messages.find((m) => m.id === input.messageId)
    if (!target) {
      throw new CommandRejectedError('Message not found.')
    }
    if (target.kind !== 'human') {
      throw new CommandRejectedError('Only human messages can be edited.')
    }
    if (target.authorId !== this.member.uid) {
      throw new CommandRejectedError('Only the author can edit this message.')
    }
    if (target.deletedAt) {
      throw new CommandRejectedError('Deleted messages cannot be edited.')
    }
    const currentVersion = target.version ?? 1
    if (currentVersion !== input.expectedVersion) {
      throw new CommandRejectedError('Message was modified elsewhere (version conflict). Your draft is retained.')
    }

    const nextVersion = currentVersion + 1
    const updatedMessages = current.messages.map((m) => {
      if (m.id === input.messageId && m.kind === 'human') {
        return {
          ...m,
          text: input.text,
          version: nextVersion,
          editedAt: Date.now(),
        }
      }
      if (m.kind === 'ai') {
        if (m.replyToId === input.messageId) {
          return {
            ...m,
            contextState: 'stale' as const,
            contextReason: 'earlier-version' as const,
          }
        }
      }
      return m
    })

    this.conversations.set(input.roomId, {
      ...current,
      messages: updatedMessages,
    })
    this.emitConversation(input.roomId)

    return {
      operationId: `${this.member.uid}_editMessage_${input.requestId}`,
      status: 'complete',
      roomId: input.roomId,
      messageId: input.messageId,
      version: nextVersion,
    }
  }

  async deleteMessage(input: DeleteMessageInput): Promise<CommandResult> {
    const current = this.requireConversation(input.roomId)
    const room = this.rooms.find((r) => r.id === input.roomId)
    if (room?.maintenanceId) {
      throw new CommandRejectedError('Updating conversation context. Message deletions are paused.')
    }
    if (current.generation?.state === 'pending') {
      throw new CommandRejectedError('A reply is currently in progress. Message deletions are paused.')
    }
    const target = current.messages.find((m) => m.id === input.messageId)
    if (!target) {
      throw new CommandRejectedError('Message not found.')
    }
    if (target.kind !== 'human') {
      throw new CommandRejectedError('Only human messages can be deleted.')
    }
    if (target.authorId !== this.member.uid) {
      throw new CommandRejectedError('Only the author can delete this message.')
    }
    if (target.deletedAt) {
      throw new CommandRejectedError('Message is already deleted.')
    }
    const currentVersion = target.version ?? 1
    if (currentVersion !== input.expectedVersion) {
      throw new CommandRejectedError('Message was modified elsewhere (version conflict).')
    }

    const nextVersion = currentVersion + 1
    const updatedMessages = current.messages.map((m) => {
      if (m.id === input.messageId && m.kind === 'human') {
        return {
          ...m,
          text: '',
          version: nextVersion,
          deletedAt: Date.now(),
        }
      }
      if (m.kind === 'ai') {
        if (m.replyToId === input.messageId) {
          return {
            ...m,
            contextState: 'stale' as const,
            contextReason: 'deleted-message' as const,
          }
        }
      }
      return m
    })

    this.conversations.set(input.roomId, {
      ...current,
      messages: updatedMessages,
    })
    this.emitConversation(input.roomId)

    return {
      operationId: `${this.member.uid}_deleteMessage_${input.requestId}`,
      status: 'complete',
      roomId: input.roomId,
      messageId: input.messageId,
      version: nextVersion,
      deletedCount: 1,
    }
  }

  async resumeMaintenance(operationId: string): Promise<CommandResult> {
    return {
      operationId,
      status: 'complete',
    }
  }

  private async finishReply(roomId: string, promptMessageId: string) {
    const fail = this.scenario === 'ai-error'
    if (fail) this.scenario = 'normal'
    await wait(1200)
    const current = this.requireConversation(roomId)
    if (current.generation?.promptMessageId !== promptMessageId || current.generation.state !== 'pending') return
    if (fail) {
      this.conversations.set(roomId, { ...current, generation: { ...current.generation, state: 'failed', canRetry: true } })
    } else {
      const answer: Message = { id: `preview-answer-${++this.counter}`, roomId, seq: (current.messages.at(-1)?.seq ?? 0) + 1, kind: 'ai', simulated: true, replyToId: promptMessageId, requesterLabel: this.member.label, text: '**Preview answer — no AI was called.**\n\nChoose one useful next step, discuss it together, and keep the details in this room. This fixed sample demonstrates the conversation layout; it does not interpret your message.', createdAt: startTime + (this.counter + 10) * 1000 }
      this.conversations.set(roomId, { messages: [...current.messages, answer], generation: null })
    }
    this.emitConversation(roomId)
  }

  private requireConversation(roomId: string) {
    const value = this.conversations.get(roomId)
    if (!value || !this.rooms.some((r) => r.id === roomId && r.members.some((m) => m.uid === this.member.uid))) throw new Error('Room not available in this preview.')
    return value
  }

  private roomState(): ReadState<readonly Room[]> {
    if (this.scenario === 'loading') return { status: 'loading' }
    if (this.scenario === 'read-error') return { status: 'error', message: 'Simulated loading failure. Choose Normal in preview states to reconnect.' }
    return { status: 'ready', data: this.scenario === 'empty' ? [] : this.rooms }
  }

  private conversationState(roomId: string): ReadState<Conversation> {
    if (this.scenario === 'loading') return { status: 'loading' }
    if (this.scenario === 'read-error') return { status: 'error', message: 'Simulated message loading failure. Choose Normal to reconnect.' }
    const data = this.conversations.get(roomId)
    if (!data) return { status: 'error', message: 'Room not available in this preview.' }
    if (!data.generation || data.generation.state !== 'failed') return { status: 'ready', data }
    const prompt = data.messages.find((m) => m.id === data.generation?.promptMessageId)
    const isAuthor = prompt?.kind === 'human' && prompt.authorId === this.member.uid
    const isDeleted = Boolean(prompt?.deletedAt)
    const isEdited = prompt?.kind === 'human' && Boolean(prompt.editedAt)
    let canRetry = true
    let retryIneligibleReason: string | undefined
    if (isDeleted) {
      canRetry = false
      retryIneligibleReason = 'The original question was deleted.'
    } else if (isEdited) {
      canRetry = false
      retryIneligibleReason = 'The original question was edited.'
    } else if (!isAuthor) {
      canRetry = false
      retryIneligibleReason = 'Only the author of the question can retry this reply.'
    }
    return {
      status: 'ready',
      data: {
        ...data,
        generation: {
          ...data.generation,
          canRetry,
          ...(retryIneligibleReason ? { retryIneligibleReason } : {}),
        },
      },
    }
  }
  private singleRoomState(roomId: string): ReadState<Room | null> {
    if (this.scenario === 'loading') return { status: 'loading' }
    if (this.scenario === 'read-error') return { status: 'error', message: 'Simulated loading failure. Choose Normal in preview states to reconnect.' }
    if (this.scenario === 'empty') return { status: 'ready', data: null }
    const room = this.rooms.find((r) => r.id === roomId) ?? null
    return { status: 'ready', data: room ? { ...room, latestSeq: this.conversations.get(roomId)?.messages.at(-1)?.seq ?? 0 } : null }
  }

  private emitRooms() {
    for (const listener of this.roomListeners) listener(this.roomState())
    for (const id of this.singleRoomListeners.keys()) this.emitSingleRoom(id)
  }

  private emitSingleRoom(roomId: string) {
    for (const listener of this.singleRoomListeners.get(roomId) ?? []) listener(this.singleRoomState(roomId))
  }

  private emitConversation(roomId: string) {
    for (const listener of this.conversationListeners.get(roomId) ?? []) listener(this.conversationState(roomId))
    this.emitSingleRoom(roomId)
  }
}
