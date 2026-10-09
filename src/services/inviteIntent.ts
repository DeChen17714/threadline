const key = 'threadline.invite'
let inMemory: string | null = null

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
  try { sessionStorage.removeItem(key) } catch { /* Storage can be disabled. */ }
}
