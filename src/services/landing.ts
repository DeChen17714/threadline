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
      description: 'Ask Threadline for a fresh perspective. Messages and replies are screened before they appear.',
      detail: 'Illustrated workflow: ask explicitly, wait for Threadline, then read the complete reply.',
      desktopPoster: '/assets/video/chat-desktop.webp',
      mobilePoster: '/assets/video/chat-mobile.webp',
    },
    {
      id: 'collaborate',
      number: '02',
      label: 'Collaborate',
      title: 'A room for more than you.',
      description: 'Create a room, share a private link, and approve who joins. Chat together or ask Threadline.',
      detail: 'An invitation requests access. Only owner-approved members can see the conversation.',
      desktopPoster: '/assets/video/collaborate-desktop.webp',
      mobilePoster: '/assets/video/collaborate-mobile.webp',
    },
    {
      id: 'continue',
      number: '03',
      label: 'Continue',
      title: 'Pick up where you left off.',
      description: 'Return to saved conversations. Edit or delete your own messages without hiding what earlier AI replies used.',
      detail: 'Illustrated edit: the saved answer stays unchanged and is marked “Reply to earlier version”.',
      desktopPoster: '/assets/video/continue-desktop.webp',
      mobilePoster: '/assets/video/continue-mobile.webp',
    },
  ],
}
