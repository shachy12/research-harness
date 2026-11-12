import { LockIcon, LockOpenIcon } from 'lucide-react'
import { useSandboxStatus } from '@/api/queries'
import { cn } from '@/lib/utils'

/**
 * "Run in the sandbox" for the nodes a dialog creates (fork: the branches, merge: the merged
 * node). Turned off for a context that ran in the sandbox, it warns why that matters.
 */
export function SandboxSwitch({ checked, onChange, untrusted, what }: {
  checked: boolean
  onChange: (checked: boolean) => void
  /** The context the new nodes inherit has replies written in the sandbox. */
  untrusted: boolean
  /** "the branches", "the merged node". */
  what: string
}) {
  const status = useSandboxStatus().data
  if (status && !status.supported) return null
  return (
    <label
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        checked ? 'border-secure/40 bg-secure-soft/50' : untrusted && 'border-exposed/50 bg-exposed-soft/60',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--status-secure)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className={cn('inline-flex items-center gap-1 font-medium', checked ? 'text-secure' : 'text-exposed')}>
          {checked ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
          Run in the sandbox
        </span>
        <span className="block text-xs text-muted-foreground">
          {checked
            ? `${what[0].toUpperCase()}${what.slice(1)} run in a Docker container that sees only the project folder (read-only) and their own copy.`
            : untrusted
              ? `This context ran in the sandbox and may hold instructions from untrusted pages or files; ${what} will run on this machine with them.`
              : `${what[0].toUpperCase()}${what.slice(1)} run on this machine.`}
        </span>
      </span>
    </label>
  )
}
