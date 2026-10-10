import type { CommandResult } from '@threadline/shared'

export interface InvitationPort {
  issue(roomId: string, requestId: string): Promise<CommandResult>
  revoke(roomId: string, requestId: string): Promise<CommandResult>
  request(token: string, requestId: string): Promise<CommandResult>
  status(joinRequestId: string): Promise<CommandResult>
  list(roomId: string): Promise<CommandResult>
  decide(roomId: string, joinRequestId: string, decision: 'approve' | 'reject', requestId: string): Promise<CommandResult>
}
