import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { LandingChapter } from '@threadline/shared'
import { useMediaQuery } from '@mui/material'
import styles from './ChapterMedia.module.css'

export interface ChapterMediaProps {
  readonly chapter: LandingChapter
  readonly layout: 'desktop' | 'mobile'
  readonly enabled: boolean
  readonly className?: string
  readonly loading?: 'eager' | 'lazy'
}

export type PlaybackState = 'idle' | 'loading' | 'verifying' | 'playing' | 'paused' | 'fallback'

function subscribeVisibility(notify: () => void) {
  document.addEventListener('visibilitychange', notify)
  return () => document.removeEventListener('visibilitychange', notify)
}

function pageVisible() {
  return document.visibilityState === 'visible'
}

function sampleFrameTransparency(video: HTMLVideoElement): boolean {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 4
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return false
    // The approved clips have a fully transparent corner outside their chrome.
    context.drawImage(video, 0, 0, 4, 4, 0, 0, 4, 4)
    const { data } = context.getImageData(0, 0, 4, 4)
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 10) return false
    }
    return true
  } catch {
    return false
  }
}

export function ChapterMedia(props: ChapterMediaProps): JSX.Element {
  const highResolution = useMediaQuery('(min-resolution: 2dppx)')
  // A source is a distinct media resource; never carry its verdict into another clip.
  return (
    <MediaSource
      key={`${props.chapter.id}-${props.layout}-${highResolution ? '4k' : 'web'}`}
      chapter={props.chapter}
      layout={props.layout}
      enabled={props.enabled}
      className={props.className}
      loading={props.loading}
      highResolution={highResolution}
    />
  )
}

function MediaSource({ chapter, layout, enabled, className, loading = 'eager', highResolution }: ChapterMediaProps & { readonly highResolution: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const verifiedAlpha = useRef(false)
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'loading' | 'playing' | 'fallback'>('loading')
  const documentVisible = useSyncExternalStore(subscribeVisibility, pageVisible, () => false)
  const videoSrc = `/assets/video/${chapter.id}-${layout}${highResolution ? '-4k' : ''}.webm`
  const poster = layout === 'desktop' ? chapter.desktopPoster : chapter.mobilePoster
  const shouldPlay = enabled && visible && documentVisible && status !== 'fallback'

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.15)
    }, { threshold: [0, 0.15] })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = true
    if (!shouldPlay) {
      video.pause()
      return
    }
    let cancelled = false
    let failed = false
    const fail = () => {
      if (cancelled || failed) return
      failed = true
      video.pause()
      setStatus('fallback')
    }
    const timeout = window.setTimeout(fail, 3500)
    video.addEventListener('error', fail)
    void video.play().then(() => {
      if (cancelled || failed) return
      window.clearTimeout(timeout)
      if (!verifiedAlpha.current) verifiedAlpha.current = sampleFrameTransparency(video)
      if (!verifiedAlpha.current) {
        fail()
      } else {
        setStatus('playing')
      }
    }).catch(() => {
      // Cleanup marks cancelled before its intentional pause rejects play().
      fail()
    })
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      video.removeEventListener('error', fail)
      video.pause()
    }
  }, [shouldPlay])

  // System reduced-motion preference and true playback failures always show the poster.
  // Intentional pauses (such as user animation toggle or offscreen pause) retain the valid video frame
  // to avoid jarring poster flashes.
  const showPoster = status !== 'playing' || prefersReducedMotion
  const showVideo = !showPoster
  const playbackState: PlaybackState = status === 'fallback'
    ? 'fallback'
    : !shouldPlay ? 'paused' : status

  return (
    <div
      ref={containerRef}
      className={`${styles.mediaContainer} ${styles[layout]} ${className ?? ''}`}
      data-playback-state={playbackState}
      data-layout={layout}
      data-chapter={chapter.id}
    >
      <img
        src={poster}
        alt={`Threadline interface demonstration: ${chapter.label} chapter`}
        className={`${styles.poster} ${!showPoster ? styles.posterHidden : ''}`}
        width={layout === 'desktop' ? 1920 : 800}
        height={layout === 'desktop' ? 1280 : 1000}
        loading={loading}
        decoding="async"
      />
      <video
        ref={videoRef}
        className={`${styles.video} ${showVideo ? styles.videoVisible : ''}`}
        muted
        playsInline
        loop
        preload="none"
        aria-hidden="true"
        tabIndex={-1}
        width={layout === 'desktop' ? 1920 : 800}
        height={layout === 'desktop' ? 1280 : 1000}
        src={status !== 'fallback' && (shouldPlay || status === 'playing') ? videoSrc : undefined}
      />
    </div>
  )
}
