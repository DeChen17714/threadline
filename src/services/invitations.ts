import type { CommandResult } from '@threadline/shared'

export interface InvitationPort {
  issue(roomId: string, requestId: string): Promise<CommandResult>
  revoke(roomId: string, requestId: string): Promise<CommandResult>
  preview(token: string): Promise<CommandResult>
  join(token: string, requestId: string): Promise<CommandResult>
}
