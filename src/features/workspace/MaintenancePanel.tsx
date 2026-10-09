import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Fade, Typography, useMediaQuery } from '@mui/material'
import type { CommandResult, OperationStatus } from '@threadline/shared'
import type { MaintenancePort } from '../../services/maintenance'

function DeletionCompleteNotice({ onDismiss }: { onDismiss(): void }) {
  const [visible, setVisible] = useState(true)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [])
  return <Fade in={visible} timeout={reducedMotion ? 0 : 250} onExited={onDismiss} unmountOnExit>
    <Alert severity="success">Room deletion complete.</Alert>
  </Fade>
}

type Job = { operationId: string; roomId: string; status: OperationStatus; deletedCount: number; error?: string }
type Actions = { refresh(): void; more(): void; retry(id: string): void }
export function MaintenancePanel({ port, refreshRevision }: { port: MaintenancePort; refreshRevision: number }) {
  const [jobs, setJobs] = useState<readonly Job[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const actions = useRef<Actions | null>(null)
  useEffect(() => {
    let active = true
    let queued = false
    let refreshAfterWork = false
    let currentJobs: readonly Job[] = []
    let cursor: string | null = null
    function publish() { if (active) setJobs(currentJobs) }
    function enqueue(work: () => Promise<void>) {
      if (queued || !active) return
      queued = true
      queue.current = queue.current.then(async () => {
        if (!active) return
        setWorking(true); setError(null)
        try { await work() }
        catch { if (active) setError('Cleanup status could not be confirmed. Check your connection and retry discovery.') }
        finally {
          queued = false
          if (active) {
            setWorking(false)
            if (refreshAfterWork) { refreshAfterWork = false; enqueue(() => discover(false)) }
          }
        }
      })
    }
    async function resumeJobs(onlyId?: string) {
      for (const job of currentJobs) {
        if (!active) return
        if (onlyId && job.operationId !== onlyId) continue
        if (job.status !== 'pending' && job.status !== 'failed') continue
        let progress = job.deletedCount
        try {
          while (active) {
            const result = await port.resume(job.operationId)
            if (!active) return
            if (typeof result.deletedCount !== 'number') throw new Error('Unconfirmed cleanup progress')
            currentJobs = currentJobs.map((item) => item.operationId === job.operationId ? { ...item, status: result.status, deletedCount: result.deletedCount!, error: undefined } : item)
            publish()
            if (result.status === 'complete') { setCompleted(true); break }
            if (result.status !== 'pending' || result.deletedCount <= progress) throw new Error('Cleanup needs recovery')
            progress = result.deletedCount
          }
        } catch {
          if (!active) return
          currentJobs = currentJobs.map((item) => item.operationId === job.operationId ? { ...item, error: 'Deletion is not confirmed complete. Retry cleanup.' } : item)
          publish(); return
        }
      }
    }
    async function discover(append: boolean) {
      const result: CommandResult = await port.listPending(append ? cursor : null)
      if (!active) return
      if (result.status !== 'complete' || !result.operations) throw new Error('Unconfirmed discovery')
      const known = new Set(append ? currentJobs.map((job) => job.operationId) : [])
      currentJobs = [...(append ? currentJobs : []), ...result.operations.filter((job) => !known.has(job.operationId))]
      cursor = result.nextCursor ?? null
      setNextCursor(cursor); publish()
      await resumeJobs()
    }
    const handlers: Actions = {
      refresh: () => { if (queued) refreshAfterWork = true; else enqueue(() => discover(false)) },
      more: () => { if (cursor) enqueue(() => discover(true)) },
      retry: (id) => enqueue(() => resumeJobs(id)),
    }
    actions.current = handlers
    handlers.refresh()
    window.addEventListener('online', handlers.refresh)
    return () => { active = false; window.removeEventListener('online', handlers.refresh); if (actions.current === handlers) actions.current = null }
  }, [port, refreshRevision])
  const remaining = jobs.filter((job) => job.status === 'pending' || job.status === 'failed')
  if (!remaining.length && !nextCursor && !error && !completed && !working) return null
  return <Box component="section" aria-label="Room maintenance" sx={{ p: 2, maxHeight: '30dvh', overflow: 'auto', flexShrink: 0, '& .MuiButton-text': { color: 'text.primary' } }}>
    {working && <Box role="status"><CircularProgress size={20} /> Checking room cleanup…</Box>}
    {completed && !working && !remaining.length && <DeletionCompleteNotice onDismiss={() => setCompleted(false)} />}
    {error && <Alert severity="error">{error}<Button disabled={working} onClick={() => actions.current?.refresh()} sx={{ minHeight: 44 }}>Retry discovery</Button></Alert>}
    {remaining.map((job) => <Alert key={job.operationId} severity={job.error || job.status === 'failed' ? 'warning' : 'info'} sx={{ mt: 1 }}>
      {job.error ?? (job.status === 'failed' ? 'Room cleanup needs recovery.' : 'Room deletion is pending.')}
      <Typography variant="body2">{job.deletedCount} records removed</Typography>
      <Button disabled={working} onClick={() => actions.current?.retry(job.operationId)} sx={{ minHeight: 44 }}>Retry cleanup</Button>
    </Alert>)}
    {nextCursor && <Button disabled={working} onClick={() => actions.current?.more()} sx={{ minHeight: 44 }}>Load more operations</Button>}
    {(remaining.length > 0 || nextCursor) && <Typography variant="caption" component="p">Cleanup can resume on your next visit. It does not continue automatically while every client is closed.</Typography>}
  </Box>
}
