import { z } from 'zod'

const uuid = z.uuid()
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const commandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ requestId: uuid, operation: z.literal('createRoom'), input: z.strictObject({ name: z.string().trim().min(1).max(80), description: z.string().max(500) }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('sendRoomMessage'), input: z.strictObject({ roomId: uuid, messageId: uuid, text: z.string().min(1).max(4000).refine((text) => text.trim().length > 0) }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('editMessage'), input: z.strictObject({ roomId: uuid, messageId: uuid, expectedVersion: z.number().int().positive(), text: z.string().min(1).max(4000).refine((text) => text.trim().length > 0) }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('deleteMessage'), input: z.strictObject({ roomId: uuid, messageId: uuid, expectedVersion: z.number().int().positive() }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('askThreadline'), input: z.strictObject({ roomId: uuid, messageId: uuid, text: z.string().min(1).max(4000).refine((text) => text.trim().length > 0) }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('retryAiReply'), input: z.strictObject({ roomId: uuid, promptMessageId: uuid, generationId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('recoverGeneration'), input: z.strictObject({ roomId: uuid, generationId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('getOperation'), input: z.strictObject({ operationId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('issueInvite'), input: z.strictObject({ roomId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('revokeInvite'), input: z.strictObject({ roomId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('requestJoin'), input: z.strictObject({ token }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('getJoinStatus'), input: z.strictObject({ joinRequestId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('listJoinRequests'), input: z.strictObject({ roomId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('decideJoin'), input: z.strictObject({ roomId: uuid, joinRequestId: uuid, decision: z.enum(['approve', 'reject']) }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('deleteRoom'), input: z.strictObject({ roomId: uuid }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('listPendingOperations'), input: z.strictObject({ cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).nullable() }) }),
  z.strictObject({ requestId: uuid, operation: z.literal('resumeMaintenance'), input: z.strictObject({ operationId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }) }),
])
export type Command = z.infer<typeof commandSchema>
export type OperationStatus = 'complete' | 'pending' | 'failed' | 'cancelled'
export type ModerationErrorCode = 'screening-blocked' | 'screening-unavailable'
export type JoinStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export interface JoinRequestSummary {
  readonly joinRequestId: string
  readonly applicantUid: string
  readonly applicantLabel: string
  readonly expiresAt: number
}
export interface CommandResult {
  readonly operationId: string
  readonly status: OperationStatus
  readonly roomId?: string
  readonly messageId?: string
  readonly seq?: number
  readonly version?: number
  readonly token?: string
  readonly tokenUnavailable?: boolean
  readonly expiresAt?: number
  readonly joinRequestId?: string
  readonly joinStatus?: JoinStatus
  readonly joinRequests?: readonly JoinRequestSummary[]
  readonly operations?: readonly { readonly operationId: string; readonly roomId: string; readonly status: OperationStatus; readonly deletedCount: number }[]
  readonly nextCursor?: string | null
  readonly deletedCount?: number
  readonly errorCode?: ModerationErrorCode
}
