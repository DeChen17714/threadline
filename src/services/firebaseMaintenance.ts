import type { Functions } from 'firebase/functions'
import { httpsCallable } from 'firebase/functions'
import type { Auth } from 'firebase/auth'
import type { Command, CommandResult } from '@threadline/shared'
import type { MaintenancePort } from './maintenance'

export function createFirebaseMaintenance(
  functions: Functions,
  auth: Auth,
  expectedUid: string,
): MaintenancePort {
  function requireAccount(): void {
    if (auth.currentUser?.uid !== expectedUid) {
      throw new Error('Account changed; maintenance action cancelled.')
    }
  }

  const command = httpsCallable<Command, CommandResult>(functions, 'command')

  return {
    async deleteRoom(roomId: string, requestId: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId,
        operation: 'deleteRoom',
        input: { roomId },
      })
      requireAccount()
      return result.data
    },

    async getOperation(operationId: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId: crypto.randomUUID(),
        operation: 'getOperation',
        input: { operationId },
      })
      requireAccount()
      return result.data
    },

    async listPending(cursor: string | null): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId: crypto.randomUUID(),
        operation: 'listPendingOperations',
        input: { cursor },
      })
      requireAccount()
      return result.data
    },

    async resume(operationId: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId: crypto.randomUUID(),
        operation: 'resumeMaintenance',
        input: { operationId },
      })
      requireAccount()
      return result.data
    },
  }
}
