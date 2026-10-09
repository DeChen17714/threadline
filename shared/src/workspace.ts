export interface Member {
  readonly uid: string
  readonly label: string
}

export interface Room {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly creatorId: string
  readonly members: readonly Member[]
  readonly createdAt: number
  readonly latestSeq?: number
  readonly maintenanceId?: string | null
  readonly maintenanceState?: 'updating-context' | null
}

interface MessageBase {
  readonly id: string
  readonly roomId: string
  readonly seq: number
  readonly text: string
  readonly createdAt: number
  readonly version?: number
  readonly editedAt?: number | null
  readonly deletedAt?: number | null
}

export interface HumanMessage extends MessageBase {
  readonly kind: 'human'
  readonly authorId: string
  readonly authorLabel: string
  readonly intent: 'room' | 'ask-ai'
}

export interface AiMessage extends MessageBase {
  readonly kind: 'ai'
  readonly replyToId: string
  readonly requesterLabel: string
  readonly simulated?: boolean
  readonly contextState?: 'stale' | 'current' | null
  readonly contextReason?: 'earlier-version' | 'earlier-context-changed' | 'deleted-message' | null
}

export type Message = HumanMessage | AiMessage

export interface Generation {
  readonly promptMessageId: string
  readonly requesterLabel: string
  readonly state: 'pending' | 'failed'
  readonly id?: string
  readonly requesterId?: string
  readonly expiresAt?: number
  readonly simulated?: boolean
  readonly canRetry?: boolean
  readonly retryIneligibleReason?: string
  readonly retryPending?: boolean
  readonly retryError?: string | null
  readonly retryUncertain?: boolean
  readonly errorCode?: string | null
}

export interface RetryReplyInput {
  readonly requestId: string
  readonly roomId: string
  readonly promptMessageId: string
  readonly generationId: string
}

export interface EditMessageInput {
  readonly requestId: string
  readonly roomId: string
  readonly messageId: string
  readonly expectedVersion: number
  readonly text: string
}

export interface DeleteMessageInput {
  readonly requestId: string
  readonly roomId: string
  readonly messageId: string
  readonly expectedVersion: number
}

export interface Conversation {
  readonly messages: readonly Message[]
  readonly generation: Generation | null
}

export interface MessageWindow {
  readonly upperSeq: number | null
  readonly limit: number
}

export type ReadState<T> =
  | { readonly status: 'loading'; readonly data?: T }
  | { readonly status: 'error'; readonly message: string; readonly data?: T }
  | { readonly status: 'ready'; readonly data: T }

export type MessageIntent = HumanMessage['intent']
