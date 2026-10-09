import type { CommandResult, Conversation, DeleteMessageInput, EditMessageInput, Member, MessageIntent, MessageWindow, ReadState, RetryReplyInput, Room } from '@threadline/shared'

export class CommandRejectedError extends Error {
  override name = 'CommandRejectedError'
}

export class CommandUncertainError extends Error {
  override name = 'CommandUncertainError'
}

export interface MessageEditDraft {
  readonly draft: string
  readonly requestId: string
  readonly error: string | null
  readonly pending: boolean
  readonly expectedVersion?: number
  readonly submittedText?: string
  readonly uncertain?: boolean
}

export interface MessageDeleteState {
  readonly requestId: string
  readonly expectedVersion: number
  readonly pending: boolean
  readonly error: string | null
  readonly uncertain?: boolean
}

export interface WorkspacePort {
  readonly member: Member
  readonly capabilities: { readonly conversation: boolean; readonly askAi: boolean }
  subscribeRoom(roomId: string, notify: (state: ReadState<Room | null>) => void): () => void
  loadMoreRooms?(): void
  retryRooms?(): void
  dispose?(): void
  subscribeRooms(notify: (state: ReadState<readonly Room[]>) => void): () => void
  subscribeConversation(roomId: string, notify: (state: ReadState<Conversation>) => void, window: MessageWindow): () => void
  createRoom(input: { name: string; description: string }): Promise<Room>
  send(input: { requestId: string; roomId: string; messageId: string; text: string; intent: MessageIntent }): Promise<void>
  retryReply(input: RetryReplyInput): Promise<void>
  editMessage(input: EditMessageInput): Promise<CommandResult>
  resumeMaintenance(operationId: string): Promise<CommandResult>
  deleteMessage(input: DeleteMessageInput): Promise<CommandResult>
}

export type PreviewScenario = 'normal' | 'empty' | 'loading' | 'read-error' | 'send-error' | 'ai-error' | 'create-error'

export interface PreviewControls {
  readonly scenario: PreviewScenario
  setScenario(scenario: PreviewScenario): void
}
