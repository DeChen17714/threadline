import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Paper, TextField, Typography } from '@mui/material'
import type { AuthPort } from '../../services/auth'
import styles from './AuthPage.module.css'

type Verification =
  | { readonly code: string; readonly status: 'verified'; readonly email: string }
  | { readonly code: string; readonly status: 'failed' }

export interface ResetPasswordPageProps {
  readonly auth: AuthPort
  readonly code: string | null
  readonly onPasswordChanged: () => void
  readonly onRestart: () => void
}

interface ResetPasswordFormProps {
  readonly auth: AuthPort
  readonly code: string
  readonly onCompleted: () => void
}

function ResetPasswordForm({ auth, code, onCompleted }: ResetPasswordFormProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const passwordHelperId = useId()
  const confirmPasswordHelperId = useId()

  const passwordValid = password.length >= 6
  const matchValid = password === confirmPassword
  const passwordError = attempted && !passwordValid ? 'Use at least 6 characters.' : null
  const confirmError = attempted && !matchValid ? 'Passwords do not match.' : null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current) return

    setAttempted(true)
    if (!passwordValid || !matchValid) return

    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      await auth.confirmPasswordReset(code, password)
      setPassword('')
      setConfirmPassword('')
      onCompleted()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not change your password. Request a fresh reset link and try again.')
    } finally {
      setSubmitting(false)
      submittingRef.current = false
    }
  }

  return (
    <Box component="form" onSubmit={(event) => { void handleSubmit(event) }} className={styles.form} noValidate>
      {submitError ? <Alert severity="error" role="alert">{submitError}</Alert> : null}
      <TextField
        id="new-password"
        label="New password"
        type="password"
        name="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => { setPassword(event.target.value); setSubmitError(null) }}
        required
        fullWidth
        error={Boolean(passwordError)}
        helperText={passwordError ?? 'Use at least 6 characters.'}
        FormHelperTextProps={{ id: passwordHelperId, role: passwordError ? 'alert' : undefined }}
        inputProps={{ minLength: 6, 'aria-describedby': passwordHelperId }}
      />
      <TextField
        id="confirm-password"
        label="Confirm new password"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(event) => { setConfirmPassword(event.target.value); setSubmitError(null) }}
        required
        fullWidth
        error={Boolean(confirmError)}
        helperText={confirmError ?? 'Enter the same password again.'}
        FormHelperTextProps={{ id: confirmPasswordHelperId, role: confirmError ? 'alert' : undefined }}
        inputProps={{ 'aria-describedby': confirmPasswordHelperId }}
      />
      <Button type="submit" variant="contained" color="primary" fullWidth disabled={submitting} sx={{ minHeight: 44 }}>
        {submitting ? 'Updating password…' : 'Update password'}
      </Button>
    </Box>
  )
}

export function ResetPasswordPage({ auth, code, onPasswordChanged, onRestart }: ResetPasswordPageProps) {
  const [verification, setVerification] = useState<Verification | null>(null)
  const [completedCode, setCompletedCode] = useState<string | null>(null)
  const currentCode = code && code.length > 0 ? code : null
  const currentVerification = verification?.code === currentCode ? verification : null
  const verifiedEmail = currentVerification?.status === 'verified' ? currentVerification.email : null
  const verified = verifiedEmail !== null
  const verificationFailed = currentCode === null || currentVerification?.status === 'failed'
  const verifying = currentCode !== null && !verified && !verificationFailed
  const passwordChanged = completedCode === currentCode

  useEffect(() => {
    if (currentCode === null) return undefined

    let cancelled = false
    void auth.verifyPasswordResetCode(currentCode)
      .then((email) => {
        if (!cancelled) setVerification({ code: currentCode, status: 'verified', email })
      })
      .catch(() => {
        if (!cancelled) setVerification({ code: currentCode, status: 'failed' })
      })

    return () => { cancelled = true }
  }, [auth, currentCode])

  return (
    <div className={styles.authPage}>
      <section className={styles.identity} aria-label="Threadline">
        <div className={styles.identityContent}>
          <img src="/assets/brand/threadline-lockup-dark.svg" alt="Threadline" className={styles.identityLogo} width={210} height={51} />
          <div className={styles.identityCopy}>
            <Typography component="p" className={styles.eyebrow}>Account Security</Typography>
            <Typography component="h1" variant="h2" className={styles.identityHeading}>Choose a new password.</Typography>
            <Typography className={styles.identityDescription}>Choose a new password to protect your Threadline workspace.</Typography>
          </div>
        </div>
      </section>
      <main className={styles.formSurface}>
        <Paper component="section" elevation={0} className={styles.formCard} aria-labelledby="reset-title">
          <img src="/assets/brand/threadline-lockup-light.svg" alt="Threadline" className={styles.mobileLogo} width={160} height={39} />
          <Typography id="reset-title" component="h2" variant="h2" className={styles.formTitle}>Set new password</Typography>
          <Typography className={styles.formIntroduction}>
            {verifiedEmail !== null ? `Setting a new password for ${verifiedEmail}.` : 'Secure your workspace with a replacement password.'}
          </Typography>

          {verifying ? (
            <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 4 }}>
              <CircularProgress size={24} />
              <Typography>Verifying reset link…</Typography>
            </Box>
          ) : verificationFailed ? (
            <Box sx={{ display: 'grid', gap: 3 }}>
              <Alert severity="error" role="alert">We couldn’t verify this password reset link. It may be invalid, expired, or already used.</Alert>
              <Button variant="contained" color="primary" fullWidth onClick={onRestart} sx={{ minHeight: 44 }}>Request new reset link</Button>
            </Box>
          ) : passwordChanged ? (
            <Box sx={{ display: 'grid', gap: 3 }}>
              <Alert severity="success" role="status">Password changed. You can now sign in with your new password.</Alert>
              <Button variant="contained" color="primary" fullWidth onClick={onPasswordChanged} sx={{ minHeight: 44 }}>Sign in</Button>
            </Box>
          ) : verified && currentCode !== null ? (
            <ResetPasswordForm key={currentCode} auth={auth} code={currentCode} onCompleted={() => setCompletedCode(currentCode)} />
          ) : null}
        </Paper>
      </main>
    </div>
  )
}
