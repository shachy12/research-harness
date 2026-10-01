import { useEffect, useState } from 'react'

/** null while checking, then whether GET /api/health answered. */
export function useServerHealth(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((res) => res.ok)
      .catch(() => false)
      .then((result) => {
        if (!cancelled) setOk(result)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return ok
}
