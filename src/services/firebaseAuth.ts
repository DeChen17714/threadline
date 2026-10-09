import type { Auth, AuthCredential, AuthError, User } from 'firebase/auth'
import { clearInviteIntent } from './inviteIntent.ts'
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, verifyPasswordResetCode,
  confirmPasswordReset, GoogleAuthProvider, signInWithPopup, linkWithCredential,
} from 'firebase/auth'
import type { AuthPort, AuthState, AuthUser } from './auth'

const messages: Record<string, string> = {
  'auth/email-already-in-use': 'An account with this email address already exists.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/weak-password': 'Use at least 6 characters for your password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/invalid-login-credentials': 'Incorrect email or password.',
  'auth/user-disabled': 'This account is disabled.',
  'auth/too-many-requests': 'Too many attempts. Please try again later.',
  'auth/network-request-failed': 'Connection failed. Check your network and retry.',
  'auth/operation-not-allowed': 'This sign-in method is not enabled.',
  'auth/expired-action-code': 'This reset link has expired. Request a new link.',
  'auth/invalid-action-code': 'This reset link is invalid or has already been used.',
  'auth/popup-closed-by-user': 'Google sign-in was cancelled. You can try again or use email.',
  'auth/popup-blocked': 'Allow popups for Threadline, then try Google sign-in again.',
  'auth/cancelled-popup-request': 'Google sign-in was cancelled. You can try again or use email.',
  'auth/account-exists-with-different-credential': 'Sign in to your existing account before linking Google.',
  'auth/credential-already-in-use': 'This Google account is linked to another account.',
  'auth/requires-recent-login': 'Please sign in again before linking Google.',
}

function safeError(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  return new Error(messages[code] ?? 'This request could not be completed. Please try again.', { cause: error })
}
function identity(user: User): AuthUser {
  return { uid: user.uid, email: user.email, label: user.displayName || user.email?.split('@')[0] || 'Member' }
}
interface GoogleLink {
  credential: AuthCredential
  email: string
  expiresAt: number
  uid: string | null
}

export function createFirebaseAuth(auth: Auth): AuthPort {
  let snapshot: AuthState = { status: 'loading' }
  const listeners = new Set<() => void>()
  let unsubscribe: (() => void) | undefined
  let timer: number | undefined
  let subscriptionEpoch = 0
  let operationEpoch = 0
  let running = false
  let logoutFailed = false
  let activeOperation: Promise<void> | null = null
  let logoutOperation: Promise<void> | null = null
  let googleLink: GoogleLink | null = null
  let linkExpiryTimer: number | undefined
  let lastUid: string | null = null

  function publish(next: AuthState) {
    snapshot = next
    for (const listener of listeners) listener()
  }
  function clearLink() {
    googleLink = null
    clearTimeout(linkExpiryTimer)
  }
  function publishUser(user: User | null) {
    const uid = user?.uid ?? null
    if (lastUid !== null && uid !== lastUid) clearInviteIntent()
    lastUid = uid
    publish(user ? { status: 'signed-in', user: identity(user) } : { status: 'signed-out' })
  }
  function disconnect() {
    subscriptionEpoch++
    clearTimeout(timer)
    unsubscribe?.()
    unsubscribe = undefined
  }
  function connect() {
    disconnect()
    const epoch = subscriptionEpoch
    timer = window.setTimeout(() => {
      if (epoch === subscriptionEpoch && snapshot.status === 'loading') publish({ status: 'error', message: 'Session check timed out. Check your connection and retry.' })
    }, 10_000)
    unsubscribe = onAuthStateChanged(auth, (user) => {
      if (epoch !== subscriptionEpoch) return
      clearTimeout(timer)
      if (running || logoutFailed || user?.uid !== auth.currentUser?.uid) return
      if (googleLink && (user?.uid ?? null) === googleLink.uid && googleLink.expiresAt > Date.now()) {
        publish({ status: 'link-required', email: googleLink.email, user: user ? identity(user) : null })
        return
      }
      clearLink()
      publishUser(user)
    }, () => {
      if (epoch !== subscriptionEpoch) return
      clearTimeout(timer)
      publish({ status: 'error', message: 'Could not check your session. Please retry.' })
    })
  }
  // Invoke immediately: popup creation must remain inside the user activation event.
  function authenticate(action: () => Promise<unknown>, linking = false): Promise<void> {
    if (running) return Promise.reject(new Error('Another sign-in request is still running.'))
    if (logoutFailed) return Promise.reject(new Error('Retry signing out before starting another sign-in.'))
    running = true
    const epoch = ++operationEpoch
    if (!linking) clearLink()
    const request = (async () => {
      try {
        await action()
        if (epoch === operationEpoch && !googleLink) publishUser(auth.currentUser)
      } catch (error) {
        if (epoch === operationEpoch && !googleLink && !logoutFailed) publishUser(auth.currentUser)
        throw safeError(error)
      } finally {
        if (epoch === operationEpoch) running = false
      }
    })()
    activeOperation = request
    void request.finally(() => { if (activeOperation === request) activeOperation = null }).catch(() => {})
    return request
  }
  function logout(): Promise<void> {
    if (logoutOperation) return logoutOperation
    const epoch = ++operationEpoch
    const previous = activeOperation
    running = true
    clearLink()
    clearInviteIntent()
    publish({ status: 'signed-out' })
    const request = (async () => {
      try {
        // Hide immediately, then fence any SDK sign-in already in flight.
        await previous?.catch(() => {})
        await signOut(auth)
        logoutFailed = false
        publishUser(null)
      } catch (error) {
        logoutFailed = true
        publish({ status: 'error', message: 'Sign out did not finish. Retry to finish signing out.' })
        throw safeError(error)
      } finally {
        if (epoch === operationEpoch) running = false
      }
    })()
    logoutOperation = request
    void request.finally(() => { if (logoutOperation === request) logoutOperation = null }).catch(() => {})
    return request
  }
  function expireLink() {
    const link = googleLink
    clearLink()
    if (link && (running || (auth.currentUser?.uid ?? null) === link.uid)) {
      void logout().catch(() => {})
    } else {
      publishUser(auth.currentUser)
    }
  }
  function currentLink() {
    if (!googleLink) throw new Error('Start Google sign-in again to request a new link.')
    if (googleLink.expiresAt <= Date.now()) {
      expireLink()
      throw new Error('The Google linking request expired. Start Google sign-in again.')
    }
    return googleLink
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) {
      listeners.add(notify)
      if (listeners.size === 1) connect()
      return () => {
        listeners.delete(notify)
        if (!listeners.size) {
          disconnect()
          clearLink()
          snapshot = { status: 'loading' }
        }
      }
    },
    signUpEmail: (email, password) => authenticate(() => createUserWithEmailAndPassword(auth, email.trim(), password)),
    signInEmail: (email, password) => authenticate(() => signInWithEmailAndPassword(auth, email.trim(), password)),
    signInGoogle: () => authenticate(async () => {
      const epoch = operationEpoch
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      try {
        await signInWithPopup(auth, provider)
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'auth/account-exists-with-different-credential') {
          const authError = error as AuthError
          const email = authError.customData?.email
          const credential = GoogleAuthProvider.credentialFromError(authError)
          if (epoch === operationEpoch && credential && typeof email === 'string') {
            googleLink = { credential, email, expiresAt: Date.now() + 5 * 60_000, uid: null }
            publish({ status: 'link-required', email, user: null })
            linkExpiryTimer = window.setTimeout(expireLink, 5 * 60_000)
          }
        }
        throw error
      }
    }),
    authenticateGoogleLink: (password) => authenticate(async () => {
      const link = currentLink()
      const result = await signInWithEmailAndPassword(auth, link.email, password)
      if (googleLink !== link || auth.currentUser?.uid !== result.user.uid) throw new Error('The account changed. Start Google sign-in again.')
      link.uid = result.user.uid
      publish({ status: 'link-required', email: link.email, user: identity(result.user) })
    }, true),
    confirmGoogleLink: () => authenticate(async () => {
      const link = currentLink()
      const user = auth.currentUser
      if (!link.uid || !user || user.uid !== link.uid) {
        clearLink()
        throw new Error('The account changed. Start Google sign-in again.')
      }
      await linkWithCredential(user, link.credential)
      clearLink()
    }, true),
    cancelGoogleLink: logout,
    sendPasswordReset: async (email) => {
      try {
        await sendPasswordResetEmail(auth, email.trim(), { url: `${window.location.origin}/auth?mode=login` })
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'auth/user-not-found') return
        throw safeError(error)
      }
    },
    verifyPasswordResetCode: async (code) => {
      try { return await verifyPasswordResetCode(auth, code) } catch (error) { throw safeError(error) }
    },
    confirmPasswordReset: async (code, password) => {
      try { await confirmPasswordReset(auth, code, password) } catch (error) { throw safeError(error) }
    },
    signOut: logout,
    retry() {
      if (logoutFailed) { void logout().catch(() => {}); return }
      publish({ status: 'loading' })
      connect()
    },
  }
}
