const key = 'threadline.invite'
let inMemory: string | null = null

const requestKeyPrefix = 'threadline.join_request:'
const memoryRequests = new Map<string, string>()
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function captureInviteIntent(): void {
  if (window.location.pathname !== '/join' || !window.location.hash) return
  const candidate = window.location.hash.slice(1)
  inMemory = /^[A-Za-z0-9_-]{43}$/.test(candidate) ? candidate : null
  try {
    sessionStorage.removeItem(key)
    if (inMemory) sessionStorage.setItem(key, inMemory)
  } catch { /* Memory-only intent still survives SPA authentication. */ }
  window.history.replaceState(null, '', '/join')
}

export function readInviteIntent(): string | null {
  try { return sessionStorage.getItem(key) } catch { return inMemory }
}

export function clearInviteIntent(): void {
  inMemory = null
  memoryRequests.clear()
  try {
    sessionStorage.removeItem(key)
    const toRemove: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const storageKey = sessionStorage.key(i)
      if (storageKey?.startsWith(requestKeyPrefix)) toRemove.push(storageKey)
    }
    for (const storageKey of toRemove) sessionStorage.removeItem(storageKey)
  } catch { /* Storage can be disabled. */ }
}

export function saveJoinRequestIdentity(token: string, requestId: string, uid: string): void {
  if (!token || !uid || !uuidPattern.test(requestId)) return
  const k = `${requestKeyPrefix}${uid}:${token}`
  memoryRequests.set(k, requestId)
  try {
    sessionStorage.setItem(k, requestId)
  } catch { /* Storage can be disabled. */ }
}

export function readJoinRequestIdentity(token: string, uid: string): string | null {
  if (!token || !uid) return null
  const k = `${requestKeyPrefix}${uid}:${token}`
  try {
    const candidate = sessionStorage.getItem(k) ?? memoryRequests.get(k) ?? null
    return candidate && uuidPattern.test(candidate) ? candidate : null
  } catch {
    const candidate = memoryRequests.get(k) ?? null
    return candidate && uuidPattern.test(candidate) ? candidate : null
  }
}

export function clearJoinRequestIdentity(token: string, uid: string): void {
  if (!token || !uid) return
  const k = `${requestKeyPrefix}${uid}:${token}`
  memoryRequests.delete(k)
  try {
    sessionStorage.removeItem(k)
  } catch { /* Storage can be disabled. */ }
}
