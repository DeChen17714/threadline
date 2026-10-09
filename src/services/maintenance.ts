import type { CommandResult } from '@threadline/shared'

export interface MaintenancePort {
  deleteRoom(roomId: string, requestId: string): Promise<CommandResult>
  getOperation(operationId: string): Promise<CommandResult>
  listPending(cursor: string | null): Promise<CommandResult>
  resume(operationId: string): Promise<CommandResult>
}
