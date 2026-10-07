import { type Attachment, MAX_FOLDER_BYTES, MAX_FOLDER_FILES, MAX_UPLOAD_BYTES } from '@harness/shared'
import { useRef, useState } from 'react'
import { uploadFile, uploadFolder } from '@/api/client'
import type { PickedFolder, PickedItems } from '@/lib/dropped-files'

export interface PendingFile {
  key: string
  name: string
  size: number
  kind: 'file' | 'folder'
  fileCount?: number
  status: 'uploading' | 'ready' | 'error'
  attachment?: Attachment
  error?: string
}

let nextKey = 0
const MB = 1024 * 1024

/** Where a composer keeps its finished uploads while they aren't sent (see `drafts.ts`). */
export interface KeepAttachments {
  /** Uploads kept from before (shown as ready). */
  initial: Attachment[]
  /** An upload finished; called even after the composer has closed, so the draft still gets it. */
  onAdded: (attachment: Attachment) => void
  onRemoved: (attachment: Attachment) => void
}

/**
 * Files and folders picked for the next message. Each one uploads right away (into the project's
 * `.harness/uploads/`), so sending only has to pass the finished uploads along.
 */
export function useAttachments(projectId: string, keep?: KeepAttachments) {
  const [files, setFiles] = useState<PendingFile[]>(() =>
    (keep?.initial ?? []).map((attachment) => ({
      key: `f${nextKey++}`,
      name: attachment.name,
      size: attachment.size,
      kind: attachment.kind ?? 'file',
      fileCount: attachment.fileCount,
      status: 'ready',
      attachment,
    })),
  )
  // Removed (or sent) before their upload finished: don't keep them when it does.
  const dropped = useRef(new Set<string>())
  const update = (key: string, change: Partial<PendingFile>) =>
    setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)))

  /** Show the item, then upload it; `tooBig` is a reason to refuse it without uploading. */
  const track = (item: Omit<PendingFile, 'key' | 'status'>, tooBig: string | null, upload: () => Promise<Attachment>) => {
    const key = `f${nextKey++}`
    if (tooBig) {
      setFiles((list) => [...list, { ...item, key, status: 'error', error: tooBig }])
      return
    }
    setFiles((list) => [...list, { ...item, key, status: 'uploading' }])
    upload().then(
      (attachment) => {
        update(key, { status: 'ready', attachment, name: attachment.name })
        if (!dropped.current.has(key)) keep?.onAdded(attachment)
      },
      (err: unknown) => update(key, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }),
    )
  }

  const addFiles = (picked: FileList | File[]) => {
    for (const file of Array.from(picked)) {
      const tooBig = file.size > MAX_UPLOAD_BYTES ? `Larger than ${MAX_UPLOAD_BYTES / MB} MB` : null
      track({ name: file.name, size: file.size, kind: 'file' }, tooBig, () => uploadFile(projectId, file))
    }
  }

  const addFolders = (folders: PickedFolder[]) => {
    for (const folder of folders) {
      const size = folder.files.reduce((s, f) => s + f.file.size, 0)
      const tooBig =
        folder.files.length === 0 ? 'The folder is empty'
        : folder.files.length > MAX_FOLDER_FILES ? `More than ${MAX_FOLDER_FILES} files`
        : size > MAX_FOLDER_BYTES ? `Larger than ${MAX_FOLDER_BYTES / MB} MB`
        : null
      track(
        { name: folder.name, size, kind: 'folder', fileCount: folder.files.length },
        tooBig,
        () => uploadFolder(projectId, folder.name, folder.files),
      )
    }
  }

  return {
    files,
    addFiles,
    addFolders,
    /** Files and folders from a drop. */
    addPicked: (picked: PickedItems) => {
      if (picked.files.length) addFiles(picked.files)
      if (picked.folders.length) addFolders(picked.folders)
    },
    remove: (key: string) => {
      dropped.current.add(key)
      const removed = files.find((f) => f.key === key)?.attachment
      if (removed) keep?.onRemoved(removed)
      setFiles((list) => list.filter((f) => f.key !== key))
    },
    /** Forget everything (after sending); the caller clears what it kept itself. */
    clear: () => {
      for (const f of files) dropped.current.add(f.key)
      setFiles([])
    },
    ready: files.flatMap((f) => (f.status === 'ready' && f.attachment ? [f.attachment] : [])),
    uploading: files.some((f) => f.status === 'uploading'),
  }
}
