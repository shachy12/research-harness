import { isSkippedUploadName } from '@harness/shared'

/** What the user dropped or picked: loose files, and folders with their files' relative paths. */
export interface PickedItems {
  files: File[]
  folders: PickedFolder[]
}

export interface PickedFolder {
  name: string
  /** Paths are relative to the folder, e.g. "figures/plot.png". */
  files: { path: string; file: File }[]
}

/**
 * Read a drop. Dropped folders arrive as a tree of "entries" (the File and Directory Entries API);
 * walk it to get every file with its path, skipping hidden folders, node_modules and similar.
 * Must be called synchronously in the drop handler: the entries are only available during the event.
 */
export function readDrop(data: DataTransfer): Promise<PickedItems> {
  const entries = Array.from(data.items)
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null)

  // Browsers without entry support: plain files only.
  if (entries.length === 0) return Promise.resolve({ files: Array.from(data.files), folders: [] })
  return readEntries(entries)
}

export async function readEntries(entries: FileSystemEntry[]): Promise<PickedItems> {
  const picked: PickedItems = { files: [], folders: [] }
  for (const entry of entries) {
    if (entry.isFile) {
      picked.files.push(await fileOf(entry as FileSystemFileEntry))
    } else if (entry.isDirectory) {
      const folder: PickedFolder = { name: entry.name, files: [] }
      await walk(entry as FileSystemDirectoryEntry, '', folder.files)
      picked.folders.push(folder)
    }
  }
  return picked
}

async function walk(dir: FileSystemDirectoryEntry, prefix: string, out: PickedFolder['files']): Promise<void> {
  for (const entry of await listDirectory(dir)) {
    if (isSkippedUploadName(entry.name)) continue
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile) out.push({ path, file: await fileOf(entry as FileSystemFileEntry) })
    else if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, path, out)
  }
}

/** readEntries returns the contents in batches; call it until it returns an empty batch. */
async function listDirectory(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject))

/**
 * Files from a folder picker (`<input webkitdirectory>`): each has `webkitRelativePath` like
 * "thesis/chapters/one.tex". Group them by their top folder.
 */
export function groupPickedFolder(list: FileList): PickedFolder[] {
  const folders = new Map<string, PickedFolder>()
  for (const file of Array.from(list)) {
    const [top, ...rest] = file.webkitRelativePath.split('/')
    if (!top || rest.length === 0 || rest.some(isSkippedUploadName)) continue
    if (!folders.has(top)) folders.set(top, { name: top, files: [] })
    folders.get(top)!.files.push({ path: rest.join('/'), file })
  }
  return [...folders.values()]
}
