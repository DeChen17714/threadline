import { createContext, useContext } from 'react'
import type { Components } from 'react-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box, Typography } from '@mui/material'
import { colors } from '../../app/theme'

export interface MarkdownRendererProps {
  readonly content: string
}

const SAFE_PROTOCOL_REGEX = /^(?:https?|mailto):/i

function safeUrlTransform(url: string): string {
  const trimmed = url.trim()
  return SAFE_PROTOCOL_REGEX.test(trimmed) ? trimmed : ''
}
const PreContext = createContext(false)


const markdownComponents: Components = {
  a: ({ href, children }) => {
    if (!href || !SAFE_PROTOCOL_REGEX.test(href.trim())) {
      return <span>{children}</span>
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: colors.ink,
          textDecoration: 'underline',
          textUnderlineOffset: '2px',
          fontWeight: 500,
        }}
      >
        {children}
      </a>
    )
  },
  img: ({ alt }) => (
    <Box
      component="span"
      role="img"
      aria-label={alt ? `Image omitted: ${alt}` : 'Image omitted'}
      sx={{
        display: 'inline-block',
        px: 1,
        py: 0.5,
        borderRadius: '4px',
        fontSize: '0.85em',
        color: colors.inkSecondary,
        bgcolor: 'rgba(0, 0, 0, 0.05)',
        fontStyle: 'italic',
      }}
    >
      {alt ? `[Image: ${alt}]` : '[Image omitted]'}
    </Box>
  ),
  pre: ({ children }) => (
    <Box
      component="pre"
      tabIndex={0}
      aria-label="Code snippet"
      sx={{
        bgcolor: colors.darkRaised,
        color: '#F0EFEA',
        p: 2,
        borderRadius: '8px',
        overflowX: 'auto',
        maxWidth: '100%',
        minWidth: 0,
        my: 1.5,
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: '13px',
        lineHeight: 1.55,
        '&:focus-visible': {
          outline: `2px solid ${colors.apricot}`,
          outlineOffset: '2px',
        },
        '& code': {
          bgcolor: 'transparent',
          p: 0,
          color: 'inherit',
          borderRadius: 0,
          whiteSpace: 'pre',
        },
      }}
    >
      <PreContext.Provider value={true}>{children}</PreContext.Provider>
    </Box>
  ),
  code: function CodeComponent({ children, className }) {
    const inPre = useContext(PreContext)
    if (inPre || className) {
      return (
        <code className={className} style={{ fontFamily: '"IBM Plex Mono", monospace' }}>
          {children}
        </code>
      )
    }
    return (
      <Box
        component="code"
        sx={{
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: '0.88em',
          bgcolor: 'rgba(37, 42, 39, 0.08)',
          color: colors.ink,
          px: 0.6,
          py: 0.2,
          borderRadius: '4px',
          wordBreak: 'break-word',
        }}
      >
        {children}
      </Box>
    )
  },
  p: ({ children }) => (
    <Typography
      component="p"
      sx={{
        my: 0.75,
        whiteSpace: 'pre-wrap',
        lineHeight: 1.6,
        fontSize: '0.9375rem',
        color: 'inherit',
        '&:first-of-type': { mt: 0 },
        '&:last-of-type': { mb: 0 },
      }}
    >
      {children}
    </Typography>
  ),
  ul: ({ children }) => (
    <Box component="ul" sx={{ my: 1, pl: 2.5 }}>
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box component="ol" sx={{ my: 1, pl: 2.5 }}>
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Box component="li" sx={{ my: 0.25, lineHeight: 1.55 }}>
      {children}
    </Box>
  ),
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        borderLeft: `3px solid ${colors.apricot}`,
        m: 0,
        my: 1.5,
        pl: 2,
        color: colors.inkSecondary,
        fontStyle: 'italic',
      }}
    >
      {children}
    </Box>
  ),
  table: ({ children }) => (
    <Box sx={{ overflowX: 'auto', my: 1.5 }}>
      <Box
        component="table"
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '0.875rem',
        }}
      >
        {children}
      </Box>
    </Box>
  ),
  th: ({ children }) => (
    <Box
      component="th"
      sx={{
        border: `1px solid ${colors.dividerLight}`,
        p: 1,
        bgcolor: 'rgba(0,0,0,0.03)',
        fontWeight: 600,
        textAlign: 'left',
      }}
    >
      {children}
    </Box>
  ),
  td: ({ children }) => (
    <Box
      component="td"
      sx={{
        border: `1px solid ${colors.dividerLight}`,
        p: 1,
        textAlign: 'left',
      }}
    >
      {children}
    </Box>
  ),
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <Markdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      urlTransform={safeUrlTransform}
      components={markdownComponents}
    >
      {content}
    </Markdown>
  )
}
