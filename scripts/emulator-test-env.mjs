import { connectAuthEmulator as rawConnectAuthEmulator } from 'firebase/auth'
import { connectFirestoreEmulator as rawConnectFirestoreEmulator } from 'firebase/firestore'
import { connectFunctionsEmulator as rawConnectFunctionsEmulator } from 'firebase/functions'

export const PROJECT_ID = 'demo-threadline'
const humanPorts = new Set([8080, 9099, 5001, 4400, 4000, 4500, 9150])

function assertLoopbackHost(host, varName) {
  if (!host || typeof host !== 'string') {
    throw new Error(`Emulator test environment requires ${varName} to be set to an explicit loopback host:port.`)
  }
  let url
  try {
    url = new URL(`http://${host}`)
  } catch {
    throw new Error(`Invalid host format for ${varName}="${host}". Must be host:port.`)
  }
  const isLoopback = ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port !== '' && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash;
  if (!isLoopback || humanPorts.has(Number(url.port))) {
    throw new Error(`Refusing unsafe ${varName}. Tests require a dedicated loopback endpoint, never human-development ports.`)
  }
  return host
}

// Default loopback ports for disposable test runner:
// Auth: 9199, Firestore: 8180, Functions: 5101, Hub: 4501
export const authHost = assertLoopbackHost(process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199', 'FIREBASE_AUTH_EMULATOR_HOST')
export const [authHostname, authPortStr] = authHost.split(':')
export const authPort = Number(authPortStr || '9199')
export const authOrigin = `http://${authHost}`

export const firestoreHost = assertLoopbackHost(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8180', 'FIRESTORE_EMULATOR_HOST')
export const [firestoreHostname, firestorePortStr] = firestoreHost.split(':')
export const firestorePort = Number(firestorePortStr || '8180')
export const firestoreOrigin = `http://${firestoreHost}`

export const hubHost = assertLoopbackHost(process.env.FIREBASE_EMULATOR_HUB || '127.0.0.1:4501', 'FIREBASE_EMULATOR_HUB')
export const [hubHostname, hubPortStr] = hubHost.split(':')
export const hubPort = Number(hubPortStr || '4501')

export const functionsHost = assertLoopbackHost(
  process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST
    || process.env.FUNCTIONS_EMULATOR_HOST
    || '127.0.0.1:5101',
  'FIREBASE_FUNCTIONS_EMULATOR_HOST'
)
export const [functionsHostname, functionsPortStr] = functionsHost.split(':')
export const functionsPort = Number(functionsPortStr || '5101')
export const functionsOrigin = `http://${functionsHost}`

// Ensure standard isolated loopback emulator environment variables are set
process.env.FUNCTIONS_EMULATOR = 'true'
process.env.GCLOUD_PROJECT = PROJECT_ID
process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost
process.env.FIRESTORE_EMULATOR_HOST = firestoreHost
process.env.FIREBASE_EMULATOR_HUB = hubHost
process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST = functionsHost

// Standard endpoints
export const commandEndpoint = `${functionsOrigin}/${PROJECT_ID}/asia-southeast1/command`
export const authSignUpUrl = `${authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only`
export const documentsBaseUrl = (database = '(default)') =>
  `${firestoreOrigin}/v1/projects/${PROJECT_ID}/databases/${database}/documents`

// Client connect helpers
export function connectTestAuthEmulator(auth, options = { disableWarnings: true }, connectFn = rawConnectAuthEmulator) {
  return connectFn(auth, authOrigin, options)
}

export function connectTestFirestoreEmulator(db, connectFn = rawConnectFirestoreEmulator) {
  return connectFn(db, firestoreHostname, firestorePort)
}

export function connectTestFunctionsEmulator(functions, connectFn = rawConnectFunctionsEmulator) {
  return connectFn(functions, functionsHostname, functionsPort)
}
