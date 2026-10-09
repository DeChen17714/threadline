import { initializeApp, getApps } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { createFirebaseWorkspace } from './firebaseWorkspace'
import type { AuthUser } from './auth'
import type { WorkspacePort } from './workspace'
import { createFirebaseAuth } from './firebaseAuth'
import { createFirebaseInvitations } from './firebaseInvitations'
import type { InvitationPort } from './invitations'
import { createFirebaseMaintenance } from './firebaseMaintenance'
import type { MaintenancePort } from './maintenance'
import type { AuthPort } from './auth'

export type FirebaseServices = { auth: AuthPort; workspace(user: AuthUser): WorkspacePort; invitations(user: AuthUser): InvitationPort; maintenance(user: AuthUser): MaintenancePort } | { error: string }

const emulatorConnections = globalThis as typeof globalThis & { threadlineFirestoreEmulators?: WeakSet<object> }
emulatorConnections.threadlineFirestoreEmulators ??= new WeakSet()

export function initializeFirebase(): FirebaseServices {
  const local = import.meta.env.MODE === 'emulator' && import.meta.env.DEV
  const config = local ? {
    apiKey: 'emulator-only', projectId: 'demo-threadline', authDomain: 'demo-threadline.firebaseapp.com', appId: 'emulator-only',
  } : {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  }
  if (Object.values(config).some((value) => typeof value !== 'string' || !value.trim())) {
    return { error: 'Firebase is not configured. Supply the public Firebase web configuration, or run the isolated emulator setup. No preview data is substituted.' }
  }
  try {
    const app = getApps()[0] ?? initializeApp(config)
    if (!local) {
      const siteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY
      if (!siteKey?.trim()) return { error: 'Firebase App Check is not configured for this site. Complete the approved live setup, or use isolated emulators.' }
      initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true })
    }
    const auth = getAuth(app)
    if (local && !auth.emulatorConfig) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    const db = getFirestore(app)
    const functions = getFunctions(app, 'asia-southeast1')
    if (local) {
      if (!emulatorConnections.threadlineFirestoreEmulators?.has(db)) {
        connectFirestoreEmulator(db, '127.0.0.1', 8080)
        emulatorConnections.threadlineFirestoreEmulators?.add(db)
      }
      connectFunctionsEmulator(functions, '127.0.0.1', 5001)
    }
    return { auth: createFirebaseAuth(auth), workspace: (user) => createFirebaseWorkspace(db, functions, auth, user), invitations: (user) => createFirebaseInvitations(functions, auth, user.uid), maintenance: (user) => createFirebaseMaintenance(functions, auth, user.uid) }
  } catch {
    return { error: 'Firebase could not start. Check the public web configuration and retry.' }
  }
}
