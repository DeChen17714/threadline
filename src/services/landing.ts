import type { LandingChapter } from '@threadline/shared'

export interface LandingPort {
  readonly chapters: readonly LandingChapter[]
}

export const staticLandingPort: LandingPort = {
  chapters: [
    {
      id: 'chat',
      number: '01',
      label: 'Chat',
      title: 'Good conversations. Worth keeping.',
      description: 'Think with AI. Bring someone in. Pick up where you left off.',
      detail: 'Your ideas. A room of their own.',
      desktopPoster: '/assets/video/chat-desktop.webp',
      mobilePoster: '/assets/video/chat-mobile.webp',
    },
    {
      id: 'collaborate',
      number: '02',
      label: 'Collaborate',
      title: 'A room for more than you.',
      description: 'Create a space. Invite someone in. Keep the conversation together.',
      detail: 'Better with another perspective.',
      desktopPoster: '/assets/video/collaborate-desktop.webp',
      mobilePoster: '/assets/video/collaborate-mobile.webp',
    },
    {
      id: 'continue',
      number: '03',
      label: 'Continue',
      title: 'Pick up where you left off.',
      description: 'Switch rooms. Revisit your ideas. Keep the conversation going.',
      detail: 'A place for the next thought.',
      desktopPoster: '/assets/video/continue-desktop.webp',
      mobilePoster: '/assets/video/continue-mobile.webp',
    },
  ],
}
