export interface LandingChapter {
  readonly id: 'chat' | 'collaborate' | 'continue'
  readonly number: string
  readonly label: string
  readonly title: string
  readonly description: string
  readonly detail: string
  readonly desktopPoster: string
  readonly mobilePoster: string
}

export type { Member, Room, Message, HumanMessage, AiMessage, Generation, Conversation, ReadState, MessageIntent, MessageWindow, RetryReplyInput, EditMessageInput, DeleteMessageInput } from './workspace.js'
export { commandSchema } from './commands.js'
export type { Command, CommandResult, OperationStatus } from './commands.js'
