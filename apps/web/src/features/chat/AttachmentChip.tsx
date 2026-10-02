import { FolderIcon, LoaderIcon, PaperclipIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/** A file or folder on a message, or one waiting to be sent (uploading, ready, or failed with a reason). */
export function AttachmentChip({ name, size, kind = 'file', fileCount, status = 'ready', error, onRemove }: {
  name: string
  size: number
  kind?: 'file' | 'folder'
  fileCount?: number
  status?: 'uploading' | 'ready' | 'error'
  error?: string
  onRemove?: () => void
}) {
  const Icon =
    status === 'uploading' ? LoaderIcon
    : status === 'error' ? TriangleAlertIcon
    : kind === 'folder' ? FolderIcon
    : PaperclipIcon
  const details =
    status === 'error' ? 'failed'
    : kind === 'folder' ? `${fileCount ?? 0} ${fileCount === 1 ? 'file' : 'files'} · ${formatBytes(size)}`
    : formatBytes(size)

  return (
    <span
      title={error ?? name}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs',
        status === 'error' && 'border-destructive/50 text-destructive',
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', status === 'uploading' && 'animate-spin')} aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{kind === 'folder' ? `${name}/` : name}</span>
      <span className="shrink-0 text-muted-foreground">{details}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="-mr-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  )
}
