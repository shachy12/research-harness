import type { VersionInfo } from '@harness/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpCircleIcon, CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/api/client'

const COMMAND = 'npx research-harness@latest'

/**
 * A note in the header when a newer version of the npm package is out (the server asks npm every
 * 30 minutes; this asks the server every 5). No popup: it just stays there until you update.
 */
export function UpdateNotice() {
  const version = useQuery({
    queryKey: ['version'],
    queryFn: ({ signal }) => api.get<VersionInfo>('/version', signal),
    refetchInterval: 5 * 60_000,
  })
  const [copied, setCopied] = useState(false)
  const info = version.data
  if (!info?.updateAvailable) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not allowed: the command is shown anyway
    }
  }

  return (
    <div
      role="status"
      className="flex min-w-0 items-center gap-2 rounded-full border border-merge/40 bg-merge-soft py-0.5 pr-1 pl-2.5 text-xs text-merge"
      title={`Harness ${info.latest} is on npm; this is ${info.current}. Stop Harness and start it again with "${COMMAND}". Your data carries over.`}
    >
      <ArrowUpCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate font-semibold">Update available: {info.latest}</span>
      <span className="hidden truncate text-merge/80 lg:inline">(you have {info.current}) · restart with</span>
      <button
        type="button"
        onClick={copy}
        className="flex shrink-0 items-center gap-1 rounded-full bg-background/70 px-2 py-0.5 font-mono text-[11px] text-foreground hover:bg-background"
        title="Copy the command"
      >
        {COMMAND}
        {copied ? <CheckIcon className="size-3 text-done" aria-label="Copied" /> : <CopyIcon className="size-3 text-muted-foreground" aria-hidden="true" />}
      </button>
    </div>
  )
}
