import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material'
import type { AuthPort } from '../../services/auth'
import styles from './AuthPage.module.css'

const RESEND_COOLDOWN_MS = 60_000

export interface ForgotPasswordPageProps {
  readonly auth: AuthPort
  readonly onReturnToLogin: () => void
}

export function ForgotPasswordPage({ auth, onReturnToLogin }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [pending, setPending] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null)
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const emailHelperId = useId()

  const trimmedEmail = email.trim()
  const emailValid = trimmedEmail.length > 0 && /^[^\s@]+@[^\s@]+$/.test(trimmedEmail)
  const emailError = attempted && !emailValid ? (trimmedEmail ? 'Enter a valid email address.' : 'Enter your email address.') : null
  const submitted = submittedEmail !== null

  useEffect(() => {
    if (cooldownEndsAt === null) return undefined
    const endsAt = cooldownEndsAt

    function updateCooldown() {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1_000))
      setCooldownSeconds(remaining)
      if (remaining === 0) setCooldownEndsAt(null)
    }

    updateCooldown()
    const interval = window.setInterval(updateCooldown, 1_000)
    return () => window.clearInterval(interval)
  }, [cooldownEndsAt])

  function beginCooldown() {
    setCooldownSeconds(60)
    setCooldownEndsAt(Date.now() + RESEND_COOLDOWN_MS)
  }

  async function requestReset(address: string) {
    if (submittingRef.current || cooldownSeconds > 0) return

    submittingRef.current = true
    setPending(true)
    setError(null)
    try {
      await auth.sendPasswordReset(address)
      setSubmittedEmail(address)
      beginCooldown()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset instructions. Check your network and try again.')
    } finally {
      setPending(false)
      submittingRef.current = false
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (!emailValid) return
    await requestReset(trimmedEmail)
  }

  async function handleResend() {
    if (submittedEmail === null) return
    await requestReset(submittedEmail)
  }

  const cooldownLabel = 'A link was just requested. Please wait briefly before resending.'

  return (
    <div className={styles.authPage}>
      <section className={styles.identity} aria-label="Threadline">
        <div className={styles.identityContent}>
          <img src="/assets/brand/threadline-lockup-dark.svg" alt="Threadline" className={styles.identityLogo} width={210} height={51} />
          <div className={styles.identityCopy}>
            <Typography component="p" className={styles.eyebrow}>Account Recovery</Typography>
            <Typography component="h1" variant="h2" className={styles.identityHeading}>Regain access to your workspace.</Typography>
            <Typography className={styles.identityDescription}>We send recovery instructions only to valid email addresses. Existing conversations stay private.</Typography>
          </div>
        </div>
      </section>
      <main className={styles.formSurface}>
        <Paper component="section" elevation={0} className={styles.formCard} aria-labelledby="recovery-title">
          <img src="/assets/brand/threadline-lockup-light.svg" alt="Threadline" className={styles.mobileLogo} width={160} height={39} />
          <Button onClick={onReturnToLogin} sx={{ minHeight: 44, px: 0, justifyContent: 'flex-start', mb: 2, color: 'text.secondary' }}>← Back to sign in</Button>
          <Typography id="recovery-title" component="h2" variant="h2" className={styles.formTitle}>Reset password</Typography>
          <Typography className={styles.formIntroduction}>Enter the email associated with your account to receive password reset instructions.</Typography>

          {submitted ? (
            <Box sx={{ display: 'grid', gap: 3 }}>
              <Alert severity="success" role="status">If an account can receive reset instructions, they have been sent. Check the relevant inbox and spam folder.</Alert>
              {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
              {cooldownSeconds > 0 ? <Typography color="text.secondary">{cooldownLabel}</Typography> : null}
              <Button variant="outlined" color="primary" fullWidth disabled={pending || cooldownSeconds > 0} onClick={() => { void handleResend() }} sx={{ minHeight: 44 }}>
                {pending ? 'Sending link…' : cooldownSeconds > 0 ? 'Resend available soon' : 'Resend reset link'}
              </Button>
              <Button variant="contained" color="primary" fullWidth onClick={onReturnToLogin} sx={{ minHeight: 44 }}>Return to sign in</Button>
            </Box>
          ) : (
            <Box component="form" onSubmit={(event) => { void handleSubmit(event) }} className={styles.form} noValidate>
              {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
              <TextField
                id="reset-email"
                label="Email address"
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(event) => { setEmail(event.target.value); setError(null) }}
                required
                fullWidth
                error={Boolean(emailError)}
                helperText={emailError ?? 'We will send a reset link to this address.'}
                FormHelperTextProps={{ id: emailHelperId, role: emailError ? 'alert' : undefined }}
                inputProps={{ 'aria-describedby': emailHelperId }}
              />
              <Button type="submit" variant="contained" color="primary" fullWidth disabled={pending} sx={{ minHeight: 44 }}>{pending ? 'Sending link…' : 'Send reset link'}</Button>
            </Box>
          )}
        </Paper>
      </main>
    </div>
  )
}
