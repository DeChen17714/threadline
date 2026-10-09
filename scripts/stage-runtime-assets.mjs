import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const sourceDir = path.join(rootDir, 'public')
const targetDir = path.join(rootDir, '.runtime-public')

const RUNTIME_ASSETS = [
  // Fonts and licenses
  'assets/fonts/fonts.css',
  'assets/fonts/LICENSE-IBMPlex.txt',
  'assets/fonts/LICENSE-BricolageGrotesque.txt',
  'assets/fonts/bricolage-grotesque-700.woff2',
  'assets/fonts/ibm-plex-sans-400.woff2',
  'assets/fonts/ibm-plex-sans-500.woff2',
  'assets/fonts/ibm-plex-sans-600.woff2',
  'assets/fonts/ibm-plex-mono-400.woff2',

  // Brand assets
  'assets/brand/favicon.svg',
  'assets/brand/favicon-32.png',
  'assets/brand/favicon-180.png',
  'assets/brand/favicon-192.png',
  'assets/brand/favicon-512.png',
  'assets/brand/threadline-mark.svg',
  'assets/brand/threadline-lockup-dark.svg',
  'assets/brand/threadline-lockup-light.svg',
  'assets/brand/google-signin.png',

  // UI artwork and motifs
  'assets/ui/thread-background.webp',
  'assets/ui/room-empty-state.svg',
  'assets/ui/room-motif.svg',

  // Six WebM/WebP pairs (no 4K, review MP4, or PNG video frames)
  'assets/video/chat-desktop.webm',
  'assets/video/chat-desktop.webp',
  'assets/video/chat-mobile.webm',
  'assets/video/chat-mobile.webp',
  'assets/video/collaborate-desktop.webm',
  'assets/video/collaborate-desktop.webp',
  'assets/video/collaborate-mobile.webm',
  'assets/video/collaborate-mobile.webp',
  'assets/video/continue-desktop.webm',
  'assets/video/continue-desktop.webp',
  'assets/video/continue-mobile.webm',
  'assets/video/continue-mobile.webp',
]

function stageAssets() {
  // Keep directory inodes stable: a running Vite server watches this tree.
  // Recreating it during a build can make later lazy assets resolve to SPA HTML.
  fs.mkdirSync(targetDir, { recursive: true })

  for (const relPath of RUNTIME_ASSETS) {
    const src = path.join(sourceDir, relPath)
    const dst = path.join(targetDir, relPath)

    if (!fs.existsSync(src)) {
      throw new Error(`Required canonical runtime asset missing: ${src}`)
    }

    fs.mkdirSync(path.dirname(dst), { recursive: true })
    const temporary = `${dst}.${process.pid}.tmp`
    fs.copyFileSync(src, temporary)
    fs.renameSync(temporary, dst)
  }

  // Root favicon fallback for direct /favicon.svg requests
  const rootFaviconSrc = path.join(sourceDir, 'assets/brand/favicon.svg')
  if (fs.existsSync(rootFaviconSrc)) {
    fs.copyFileSync(rootFaviconSrc, path.join(targetDir, 'favicon.svg'))
  }

  // Generate runtime-only manifest (no broken archive references to 4k, mp4, ttf, etc.)
  const runtimeCatalog = {
    status: 'approved-assets-runtime-catalog',
    design: 'Threadline revision 2; continuous graphite backdrop and three product chapters',
    staticArtwork: {
      path: 'assets/ui/thread-background.webp',
      role: 'decorative landing background; no text or interactive content',
      width: 1536,
      height: 1024,
      pageBackground: '#191B1A',
    },
    brand: {
      mark: 'assets/brand/threadline-mark.svg',
      onDark: 'assets/brand/threadline-lockup-dark.svg',
      onLight: 'assets/brand/threadline-lockup-light.svg',
      favicon: 'assets/brand/favicon.svg',
      rasterIcons: [32, 180, 192, 512],
      rasterPathPattern: 'assets/brand/favicon-{size}.png',
    },
    emptyRoomMotif: 'assets/ui/room-motif.svg',
    fonts: {
      stylesheet: 'assets/fonts/fonts.css',
      files: [
        'assets/fonts/bricolage-grotesque-700.woff2',
        'assets/fonts/ibm-plex-sans-400.woff2',
        'assets/fonts/ibm-plex-sans-500.woff2',
        'assets/fonts/ibm-plex-sans-600.woff2',
        'assets/fonts/ibm-plex-mono-400.woff2',
      ],
      licenses: [
        'assets/fonts/LICENSE-IBMPlex.txt',
        'assets/fonts/LICENSE-BricolageGrotesque.txt',
      ],
    },
    video: {
      chapters: ['chat', 'collaborate', 'continue'],
      layouts: ['desktop', 'mobile'],
      runtimeVideoPattern: '/assets/video/{chapter}-{layout}.webm',
      runtimePosterPattern: '/assets/video/{chapter}-{layout}.webp',
      clips: [
        {
          chapter: 'chat',
          desktop: {
            video: '/assets/video/chat-desktop.webm',
            poster: '/assets/video/chat-desktop.webp',
          },
          mobile: {
            video: '/assets/video/chat-mobile.webm',
            poster: '/assets/video/chat-mobile.webp',
          },
        },
        {
          chapter: 'collaborate',
          desktop: {
            video: '/assets/video/collaborate-desktop.webm',
            poster: '/assets/video/collaborate-desktop.webp',
          },
          mobile: {
            video: '/assets/video/collaborate-mobile.webm',
            poster: '/assets/video/collaborate-mobile.webp',
          },
        },
        {
          chapter: 'continue',
          desktop: {
            video: '/assets/video/continue-desktop.webm',
            poster: '/assets/video/continue-desktop.webp',
          },
          mobile: {
            video: '/assets/video/continue-mobile.webm',
            poster: '/assets/video/continue-mobile.webp',
          },
        },
      ],
    },
  }

  const manifestDst = path.join(targetDir, 'assets/manifest.json')
  fs.writeFileSync(manifestDst, JSON.stringify(runtimeCatalog, null, 2) + '\n', 'utf-8')
}

stageAssets()
