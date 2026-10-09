import { useEffect, useRef, type MouseEvent, type JSX } from 'react'
import type { LandingChapter } from '@threadline/shared'
import { Typography, useMediaQuery } from '@mui/material'
import { ChapterMedia } from './ChapterMedia'
import { useMotionPreference } from './useMotionPreference'
import styles from './LandingPage.module.css'

export interface LandingPageProps {
  readonly chapters: readonly LandingChapter[]
  readonly onTryPreview?: () => void
  readonly signedIn?: boolean
}


function renderHeadline(chapter: LandingChapter): JSX.Element {
  if (chapter.id === 'chat') {
    return (
      <>
        <span className={styles.headlinePrimary}>Good conversations. </span>
        <span className={styles.headlineAccent}>Worth keeping.</span>
      </>
    )
  }
  if (chapter.id === 'collaborate') {
    return (
      <>
        <span className={styles.headlinePrimary}>A room for </span>
        <span className={styles.headlineAccent}>more than you.</span>
      </>
    )
  }
  if (chapter.id === 'continue') {
    return (
      <>
        <span className={styles.headlinePrimary}>Pick up where </span>
        <span className={styles.headlineAccent}>you left off.</span>
      </>
    )
  }
  return <span className={styles.headlinePrimary}>{chapter.title}</span>
}

export function LandingPage({ chapters, onTryPreview, signedIn = false }: LandingPageProps): JSX.Element {
  const isDesktop = useMediaQuery('(min-width:900px)')
  const { enabled } = useMotionPreference()
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const sections = mainRef.current?.querySelectorAll('section')
    if (!sections || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.setAttribute('data-revealed', 'true')
          observer.unobserve(entry.target)
        }
      }
    }, { threshold: 0.15 })
    for (const section of sections) {
      section.setAttribute('data-revealed', section.getBoundingClientRect().top < innerHeight * 0.85 ? 'true' : 'false')
      observer.observe(section)
    }
    return () => observer.disconnect()
  }, [])
  const isDemo = import.meta.env.VITE_APP_MODE === 'demo'

  const handlePreviewClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (onTryPreview) {
      e.preventDefault()
      onTryPreview()
    }
  }

  const renderEditorial = (chapter: LandingChapter, index: number) => {
    const isFirst = index === 0

    return (
      <div className={styles.editorialColumn}>
        <p className={styles.chapterBadge}>
          {chapter.number} · {chapter.label}
        </p>

        <Typography
          component={isFirst ? 'h1' : 'h2'}
          id={`${chapter.id}-title`}
          tabIndex={-1}
          className={styles.headline}
        >
          {renderHeadline(chapter)}
        </Typography>

        <p className={styles.description}>{chapter.description}</p>

        {isFirst && (
          <div className={styles.heroCtaContainer}>
            {isDemo ? (
              <div className={styles.heroCtaGroup}>
                <a
                  href="/workspace"
                  onClick={handlePreviewClick}
                  className={styles.primaryCtaButton}
                >
                  <span>Start a conversation</span>
                  <span aria-hidden="true" className={styles.ctaArrow}>
                    →
                  </span>
                </a>
              </div>
            ) : (
              <div className={styles.heroCtaGroup}>
                <a
                  href={signedIn ? '/workspace' : '/auth?mode=signup'}
                  className={styles.primaryCtaButton}
                >
                  <span>{signedIn ? 'Open workspace' : 'Start a conversation'}</span>
                  <span aria-hidden="true" className={styles.ctaArrow}>
                    →
                  </span>
                </a>
              </div>
            )}
          </div>
        )}

      </div>
    )
  }

  return (
    <div className={styles.pageWrapper}>
      {/* Decorative continuous graphite artwork backdrop */}
      <div className={styles.backdropArtwork} aria-hidden="true" />

      {/* Accessible skip link */}
      <a href="#main-content" className={styles.skipLink}>
        Skip to main content
      </a>

      {/* Persistent top header */}
      <header role="banner" className={styles.header}>
        <div className={styles.headerContainer}>
          <a href="#main-content" className={styles.brandLink} aria-label="Threadline home">
            <img
              src="/assets/brand/threadline-lockup-dark.svg"
              alt="Threadline"
              className={styles.brandLogo}
              width={160}
              height={39}
            />
          </a>

          <div className={styles.headerActions}>
            <nav aria-label="Primary navigation" className={styles.headerNav}>
              <a href="#collaborate" className={styles.headerNavLink}>
                How it works
              </a>
            </nav>

            {isDemo ? (
              <a
                href="/workspace"
                onClick={handlePreviewClick}
                className={styles.headerCtaButton}
              >
                Open Threadline
              </a>
            ) : (
              <a href={signedIn ? '/workspace' : '/auth?mode=login'} className={styles.headerCtaButton}>
                {signedIn ? 'Open workspace' : 'Log in'}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Main content in natural document flow */}
      <main ref={mainRef} id="main-content" tabIndex={-1} className={styles.mainContent}>
        {chapters.map((chapter, index) => (
          <section
            key={chapter.id}
            id={chapter.id}
            aria-labelledby={`${chapter.id}-title`}
            className={styles.chapterSection}
          >
            <div className={styles.chapterGrid}>
              {renderEditorial(chapter, index)}

              <div className={styles.stageColumn}>
                <figure
                  className={styles.stageFigure}
                  aria-label={`Threadline interface demonstration: ${chapter.label} chapter`}
                >
                  <div className={styles.stagePictureWrapper}>
                    <ChapterMedia
                      chapter={chapter}
                      layout={isDesktop ? 'desktop' : 'mobile'}
                      enabled={enabled}
                      loading={index === 0 ? 'eager' : 'lazy'}
                    />
                  </div>

                  <figcaption className={styles.stageCaption}>
                    Illustrative preview · {chapter.label}
                  </figcaption>
                </figure>
              </div>
            </div>
          </section>
        ))}
      </main>

      {/* Footer */}
      <footer role="contentinfo" className={styles.footer}>
        <div className={styles.footerContainer}>
          <div className={styles.footerBrand}>
            <img
              src="/assets/brand/threadline-lockup-dark.svg"
              alt="Threadline"
              className={styles.brandLogo}
              width={140}
              height={34}
            />
            <p className={styles.footerNotice}>
              A room for good conversations.
            </p>
          </div>

        </div>
      </footer>
    </div>
  )
}
