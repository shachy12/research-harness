import { type Attachment, MAX_UPLOAD_BYTES } from '@harness/shared'
import { useState } from 'react'
import { uploadFile } from '@/api/client'

export interface PendingFile {
  key: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  attachment?: Attachment
  error?: string
}

let nextKey = 0

/**
 * Files picked for the next message. Each one uploads right away (into the project's
 * `.harness/uploads/`), so sending only has to pass the finished uploads along.
 */
export function useAttachments(projectId: string) {
  const [files, setFiles] = useState<PendingFile[]>([])
  const update = (key: string, change: Partial<PendingFile>) =>
    setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)))

  const add = (picked: FileList | File[]) => {
    for (const file of Array.from(picked)) {
      const key = `f${nextKey++}`
      if (file.size > MAX_UPLOAD_BYTES) {
        setFiles((list) => [...list, { key, name: file.name, size: file.size, status: 'error', error: `Larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }])
        continue
      }
      setFiles((list) => [...list, { key, name: file.name, size: file.size, status: 'uploading' }])
      uploadFile(projectId, file).then(
        (attachment) => update(key, { status: 'ready', attachment, name: attachment.name }),
        (err: unknown) => update(key, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }),
      )
    }
  }

  return {
    files,
    add,
    remove: (key: string) => setFiles((list) => list.filter((f) => f.key !== key)),
    clear: () => setFiles([]),
    ready: files.flatMap((f) => (f.status === 'ready' && f.attachment ? [f.attachment] : [])),
    uploading: files.some((f) => f.status === 'uploading'),
  }
}
