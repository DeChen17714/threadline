import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Alert,
  Box,
  Button,
  IconButton,
  InputAdornment,
  Paper,
  TextField,
  Typography,
} from '@mui/material'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import type { AuthPort } from '../../services/auth'
import styles from './AuthPage.module.css'

type AuthMode = 'login' | 'signup'

export interface AuthPageProps {
  readonly auth: AuthPort
  readonly mode: AuthMode
  readonly onModeChange: (mode: AuthMode) => void
  readonly onForgotPassword?: () => void
}

interface FormErrors {
  email?: string
  password?: string
}

function validate(email: string, password: string, mode: AuthMode): FormErrors {
  const errors: FormErrors = {}
  const trimmedEmail = email.trim()

  if (!trimmedEmail) {
    errors.email = 'Enter your email address.'
  } else if (!/^[^\s@]+@[^\s@]+$/.test(trimmedEmail)) {
    errors.email = 'Enter a valid email address.'
  }

  if (!password) {
    errors.password = 'Enter your password.'
  } else if (mode === 'signup' && password.length < 6) {
    errors.password = 'Use at least 6 characters.'
  }

  return errors
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'We could not complete that request. Check your connection and try again.'
}

export function AuthPage({ auth, mode, onModeChange, onForgotPassword }: AuthPageProps) {
  const subscribe = useCallback((notify: () => void) => auth.subscribe(notify), [auth])
  const getSnapshot = useCallback(() => auth.getSnapshot(), [auth])
  const authState = useSyncExternalStore(subscribe, getSnapshot)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)

  const [linkingPassword, setLinkingPassword] = useState('')
  const [showLinkingPassword, setShowLinkingPassword] = useState(false)
  const [linkingError, setLinkingError] = useState<string | null>(null)

  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [googlePending, setGooglePending] = useState(false)

  const emailHelperId = useId()
  const passwordHelperId = useId()
  const linkingHelperId = useId()

  const isSignup = mode === 'signup'
  const isLinkRequired = authState.status === 'link-required'
  const linkingUser = isLinkRequired ? authState.user : null
  const linkingEmail = isLinkRequired ? authState.email : ''

  const errors = attempted ? validate(email, password, mode) : {}

  function handleEmailChange(event: ChangeEvent<HTMLInputElement>) {
    setEmail(event.target.value)
    setProviderError(null)
  }

  function handlePasswordChange(event: ChangeEvent<HTMLInputElement>) {
    setPassword(event.target.value)
    setProviderError(null)
  }

  function changeMode(nextMode: AuthMode) {
    if (submittingRef.current || submitting || isLinkRequired) return
    if (nextMode !== mode) {
      setAttempted(false)
      setProviderError(null)
      onModeChange(nextMode)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current || submitting || isLinkRequired) return

    setAttempted(true)
    const validationErrors = validate(email, password, mode)
    if (Object.keys(validationErrors).length > 0) return

    setProviderError(null)
    submittingRef.current = true
    setSubmitting(true)
    try {
      if (isSignup) {
        await auth.signUpEmail(email, password)
      } else {
        await auth.signInEmail(email, password)
      }
      setPassword('')
    } catch (error) {
      setProviderError(messageFor(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  async function handleGoogleSignIn() {
    if (submittingRef.current || submitting || isLinkRequired) return
    setProviderError(null)
    submittingRef.current = true
    setSubmitting(true)
    setGooglePending(true)
    try {
      await auth.signInGoogle()
    } catch (error) {
      setProviderError(messageFor(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
      setGooglePending(false)
    }
  }

  async function handleAuthenticateLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current || submitting || !linkingPassword) return
    setLinkingError(null)
    submittingRef.current = true
    setSubmitting(true)
    try {
      await auth.authenticateGoogleLink(linkingPassword)
      setLinkingPassword('')
    } catch (error) {
      setLinkingError(messageFor(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  async function handleConfirmLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current || submitting) return
    setLinkingError(null)
    submittingRef.current = true
    setSubmitting(true)
    try {
      await auth.confirmGoogleLink()
    } catch (error) {
      setLinkingError(messageFor(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  async function handleCancelLink() {
    if (submittingRef.current || submitting) return
    setLinkingError(null)
    submittingRef.current = true
    setSubmitting(true)
    try {
      await auth.cancelGoogleLink()
      setLinkingPassword('')
    } catch (error) {
      setLinkingError(messageFor(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const title = isLinkRequired
    ? 'Link Google account'
    : isSignup
      ? 'Create your workspace'
      : 'Welcome back'

  const introduction = isLinkRequired
    ? 'Verify your account to complete Google account linking.'
    : isSignup
      ? 'Start with your email and a secure password.'
      : 'Sign in to continue to your workspace.'

  const submitLabel = isSignup ? 'Create account' : 'Sign in'

  return (
    <div className={styles.authPage}>
      <section className={styles.identity} aria-label="Threadline">
        <div className={styles.identityContent}>
          <img
            src="/assets/brand/threadline-lockup-dark.svg"
            alt="Threadline"
            className={styles.identityLogo}
            width={210}
            height={51}
          />
          <div className={styles.identityCopy}>
            <Typography component="p" className={styles.eyebrow}>
              A room for good conversations
            </Typography>
            <Typography component="h1" variant="h2" className={styles.identityHeading}>
              Bring every good thread together.
            </Typography>
            <Typography className={styles.identityDescription}>
              Start focused conversations and organize your thoughts. Share rooms with members when you are ready to collaborate.
            </Typography>
          </div>
        </div>
      </section>

      <main className={styles.formSurface}>
        <Paper
          component="section"
          elevation={0}
          className={styles.formCard}
          aria-labelledby="auth-title"
        >
          <img
            src="/assets/brand/threadline-lockup-light.svg"
            alt="Threadline"
            className={styles.mobileLogo}
            width={160}
            height={39}
          />
          <a
            className={styles.homeLink}
            href={submitting ? undefined : '/'}
            onClick={(e) => {
              if (submitting) e.preventDefault()
            }}
            aria-disabled={submitting ? 'true' : undefined}
          >
            Return home
          </a>

          <Typography id="auth-title" component="h2" variant="h2" className={styles.formTitle}>
            {title}
          </Typography>
          <Typography className={styles.formIntroduction}>{introduction}</Typography>

          {isLinkRequired ? (
            <div className={styles.linkingContainer}>
              {linkingUser === null ? (
                <Box
                  component="form"
                  onSubmit={handleAuthenticateLink}
                  className={styles.form}
                  noValidate
                >
                  <Alert severity="info" className={styles.infoAlert}>
                    An account exists for <strong>{linkingEmail}</strong> using password sign-in. Enter your password to verify your account before linking Google sign-in.
                  </Alert>

                  {linkingError ? (
                    <Alert severity="error" role="alert" className={styles.providerError}>
                      {linkingError}
                    </Alert>
                  ) : null}

                  <TextField
                    id="linking-password"
                    label="Account password"
                    type={showLinkingPassword ? 'text' : 'password'}
                    name="linkingPassword"
                    autoComplete="current-password"
                    value={linkingPassword}
                    onChange={(e) => {
                      setLinkingPassword(e.target.value)
                      setLinkingError(null)
                    }}
                    required
                    fullWidth
                    disabled={submitting}
                    error={Boolean(linkingError)}
                    helperText={linkingError ?? 'Enter your existing account password to confirm ownership.'}
                    FormHelperTextProps={{
                      id: linkingHelperId,
                      role: linkingError ? 'alert' : undefined,
                    }}
                    inputProps={{
                      'aria-describedby': linkingHelperId,
                    }}
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label={showLinkingPassword ? 'Hide password' : 'Show password'}
                            onClick={() => setShowLinkingPassword((prev) => !prev)}
                            edge="end"
                            size="large"
                            tabIndex={0}
                            sx={{ color: '#626961' }}
                          >
                            {showLinkingPassword ? (
                              <VisibilityOffIcon fontSize="small" />
                            ) : (
                              <VisibilityIcon fontSize="small" />
                            )}
                          </IconButton>
                        </InputAdornment>
                      ),
                    }}
                  />

                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    fullWidth
                    disabled={submitting || !linkingPassword}
                    className={styles.submitButton}
                  >
                    {submitting ? 'Verifying…' : 'Authenticate to link'}
                  </Button>

                  <Button
                    type="button"
                    variant="text"
                    fullWidth
                    disabled={submitting}
                    onClick={handleCancelLink}
                    className={styles.cancelLinkButton}
                  >
                    Cancel linking
                  </Button>
                </Box>
              ) : (
                <Box
                  component="form"
                  onSubmit={handleConfirmLink}
                  className={styles.form}
                  noValidate
                >
                  <Alert severity="info" className={styles.infoAlert}>
                    Identity verified for <strong>{linkingUser.email ?? linkingEmail}</strong> ({linkingUser.label}). Confirm linking this Google account to your Threadline account.
                  </Alert>

                  {linkingError ? (
                    <Alert severity="error" role="alert" className={styles.providerError}>
                      {linkingError}
                    </Alert>
                  ) : null}

                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    fullWidth
                    disabled={submitting}
                    className={styles.submitButton}
                  >
                    {submitting ? 'Linking account…' : 'Confirm Google link'}
                  </Button>

                  <Button
                    type="button"
                    variant="text"
                    fullWidth
                    disabled={submitting}
                    onClick={handleCancelLink}
                    className={styles.cancelLinkButton}
                  >
                    Cancel linking
                  </Button>
                </Box>
              )}
            </div>
          ) : (
            <>
              <Box
                component="form"
                onSubmit={handleSubmit}
                className={styles.form}
                noValidate
              >
                {providerError ? (
                  <Alert severity="error" role="alert" className={styles.providerError}>
                    {providerError}
                  </Alert>
                ) : null}

                <TextField
                  id="auth-email"
                  label="Email address"
                  type="email"
                  name="email"
                  autoComplete="email"
                  value={email}
                  onChange={handleEmailChange}
                  required
                  fullWidth
                  disabled={submitting}
                  error={Boolean(errors.email)}
                  helperText={errors.email ?? 'Use the email address for your Threadline account.'}
                  FormHelperTextProps={{
                    id: emailHelperId,
                    role: errors.email ? 'alert' : undefined,
                  }}
                  inputProps={{ 'aria-describedby': emailHelperId }}
                />

                <TextField
                  id="auth-password"
                  label="Password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete={isSignup ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={handlePasswordChange}
                  required
                  fullWidth
                  disabled={submitting}
                  error={Boolean(errors.password)}
                  helperText={
                    errors.password ??
                    (isSignup ? 'Use at least 6 characters.' : 'Enter your account password.')
                  }
                  FormHelperTextProps={{
                    id: passwordHelperId,
                    role: errors.password ? 'alert' : undefined,
                  }}
                  inputProps={{
                    'aria-describedby': passwordHelperId,
                    minLength: isSignup ? 6 : undefined,
                  }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          onClick={() => setShowPassword((prev) => !prev)}
                          edge="end"
                          size="large"
                          tabIndex={0}
                          sx={{ color: '#626961' }}
                        >
                          {showPassword ? (
                            <VisibilityOffIcon fontSize="small" />
                          ) : (
                            <VisibilityIcon fontSize="small" />
                          )}
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />

                {!isSignup && onForgotPassword ? (
                  <div className={styles.forgotPasswordRow}>
                    <Button
                      type="button"
                      variant="text"
                      disabled={submitting}
                      onClick={onForgotPassword}
                      className={styles.forgotPasswordButton}
                    >
                      Forgot password?
                    </Button>
                  </div>
                ) : null}

                <Button
                  type="submit"
                  variant="contained"
                  color="primary"
                  fullWidth
                  disabled={submitting}
                  className={styles.submitButton}
                >
                  {submitting ? 'Working…' : submitLabel}
                </Button>
              </Box>

              <div className={styles.divider} role="separator">
                <span className={styles.dividerText}>or</span>
              </div>

              <Button
                type="button"
                variant="outlined"
                fullWidth
                disabled={submitting}
                onClick={handleGoogleSignIn}
                className={styles.googleButton}
                startIcon={
                  <img
                    src="/assets/brand/google-signin.png"
                    alt=""
                    aria-hidden="true"
                    width={20}
                    height={20}
                    className={styles.googleIcon}
                  />
                }
              >
                {googlePending ? 'Opening Google…' : 'Continue with Google'}
              </Button>

              <div className={styles.modeSwitch}>
                <Typography component="span" className={styles.modePrompt}>
                  {isSignup ? 'Already have an account?' : "Don't have an account?"}
                </Typography>
                <Button
                  type="button"
                  variant="text"
                  disabled={submitting}
                  onClick={() => changeMode(isSignup ? 'login' : 'signup')}
                  className={styles.modeSwitchButton}
                >
                  {isSignup ? 'Sign in' : 'Create account'}
                </Button>
              </div>
            </>
          )}
        </Paper>
      </main>
    </div>
  )
}
