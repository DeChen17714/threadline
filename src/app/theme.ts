import { createTheme } from '@mui/material/styles'

export const colors = {
  graphite: '#191B1A',
  darkRaised: '#242724',
  sidebarActive: '#2E2A27',
  paper: '#F6F3ED',
  paperElevated: '#FFFDFA',
  humanBubble: '#FBE6D7',
  ink: '#252A27',
  inkSecondary: '#626961',
  mutedDark: '#BBBEB6',
  apricot: '#F4B58B',
  apricotHover: '#E8A376',
  inputBorder: '#80867E',
  dividerLight: '#DADDD5',
  dividerDark: '#414640',
  error: '#B53B2B',
  success: '#2E694D',
} as const

export const threadlineTheme = createTheme({
  spacing: 4,
  shape: { borderRadius: 8 },
  palette: {
    primary: { main: colors.apricot, dark: colors.apricotHover, contrastText: colors.ink },
    secondary: { main: colors.ink, contrastText: colors.paperElevated },
    background: { default: colors.paper, paper: colors.paperElevated },
    text: { primary: colors.ink, secondary: colors.inkSecondary },
    divider: colors.dividerLight,
    error: { main: colors.error },
    success: { main: colors.success },
  },
  typography: {
    fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 15,
    h1: { fontFamily: '"Bricolage Grotesque", sans-serif', fontWeight: 700, lineHeight: 1.1 },
    h2: { fontFamily: '"Bricolage Grotesque", sans-serif', fontWeight: 700, lineHeight: 1.15 },
    h3: { fontFamily: '"Bricolage Grotesque", sans-serif', fontWeight: 700, lineHeight: 1.3 },
    body1: { fontSize: '15px', lineHeight: 1.6 },
    body2: { fontSize: '13px', lineHeight: 1.5 },
    button: { textTransform: 'none', fontWeight: 500 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': { fontSynthesis: 'none' },
        body: { margin: 0, minWidth: 0 },
        '*': { boxSizing: 'border-box' },
        ':focus-visible': { outline: `2px solid ${colors.ink}`, outlineOffset: '4px' },
        'code, pre': { fontFamily: '"IBM Plex Mono", monospace', fontSize: '13px', lineHeight: 1.55 },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { minHeight: 44, borderRadius: 8 } },
    },
    MuiIconButton: { styleOverrides: { root: { minWidth: 44, minHeight: 44 } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 12, maxWidth: 460 } } },
  },
})
