import type { Functions } from 'firebase/functions'
import { httpsCallable } from 'firebase/functions'
import type { Auth } from 'firebase/auth'
import type { Command, CommandResult } from '@threadline/shared'
import type { InvitationPort } from './invitations'

export function createFirebaseInvitations(
  functions: Functions,
  auth: Auth,
  expectedUid: string,
): InvitationPort {

  function requireAccount(): void {
    if (auth.currentUser?.uid !== expectedUid) {
      throw new Error('Account changed; invitation action cancelled.')
    }
  }

  const command = httpsCallable<Command, CommandResult>(functions, 'command')

  return {
    async issue(roomId: string, requestId: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId,
        operation: 'issueInvite',
        input: { roomId },
      })
      requireAccount()
      return result.data
    },

    async revoke(roomId: string, requestId: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId,
        operation: 'revokeInvite',
        input: { roomId },
      })
      requireAccount()
      return result.data
    },

    async preview(token: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId: crypto.randomUUID(),
        operation: 'previewInvite',
        input: { token },
      })
      requireAccount()
      return result.data
    },

    async join(token: string, requestId: string): Promise<CommandResult> {
      requireAccount()
      const result = await command({
        requestId,
        operation: 'joinRoom',
        input: { token },
      })
      requireAccount()
      return result.data
    },
  }
}
