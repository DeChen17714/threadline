import { useSyncExternalStore } from 'react'
import { useMediaQuery } from '@mui/material'

type DataConnection = EventTarget & { readonly saveData?: boolean }

const dataConnection = (navigator as Navigator & { connection?: DataConnection }).connection

function subscribeDataSaving(notify: () => void) {
  dataConnection?.addEventListener('change', notify)
  return () => dataConnection?.removeEventListener('change', notify)
}

function isDataSaving() {
  return dataConnection?.saveData === true
}

export function useMotionPreference() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const saveData = useSyncExternalStore(subscribeDataSaving, isDataSaving, () => true)
  return {
    enabled: !reducedMotion && !saveData,
  }
}
