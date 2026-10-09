import { captureInviteIntent } from '../services/inviteIntent.ts'

interface RouteSnapshot { readonly url: string; readonly revision: number }
let current: RouteSnapshot | undefined
function refreshRoute() {
  captureInviteIntent()
  current = { url: window.location.pathname + window.location.search + window.location.hash, revision: (current?.revision ?? 0) + 1 }
}
export function subscribeRoute(notify: () => void) {
  const handleRoute = () => { refreshRoute(); notify() }
  window.addEventListener('popstate', handleRoute)
  window.addEventListener('hashchange', handleRoute)
  return () => { window.removeEventListener('popstate', handleRoute); window.removeEventListener('hashchange', handleRoute) }
}
export function routeSnapshot(): RouteSnapshot {
  if (!current) refreshRoute()
  return current!
}
export function navigate(path: string, replace = false) {
  if (replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
export function privateDestination(value: string | null): string {
  if (value === '/workspace' || value === '/join' || (value !== null && /^\/rooms\/[a-zA-Z0-9-]+$/.test(value))) return value
  return '/workspace'
}
