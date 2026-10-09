/** A folder of the Files view's tree. */
export interface TreeFolder {
  name: string
  /** Its path relative to the project folder ('' for the top). */
  path: string
  folders: TreeFolder[]
  files: { name: string; path: string }[]
}

/**
 * Build the tree from '/'-separated paths: folders first, then files, each by name (case
 * ignored, numbers in order: file2 before file10), like a file manager.
 */
export function buildTree(paths: string[]): TreeFolder {
  const top: TreeFolder = { name: '', path: '', folders: [], files: [] }
  const folders = new Map<string, TreeFolder>([['', top]])
  const folderAt = (path: string): TreeFolder => {
    const known = folders.get(path)
    if (known) return known
    const cut = path.lastIndexOf('/')
    const folder: TreeFolder = { name: path.slice(cut + 1), path, folders: [], files: [] }
    folderAt(cut === -1 ? '' : path.slice(0, cut)).folders.push(folder)
    folders.set(path, folder)
    return folder
  }
  for (const path of new Set(paths)) {
    const cut = path.lastIndexOf('/')
    folderAt(cut === -1 ? '' : path.slice(0, cut)).files.push({ name: path.slice(cut + 1), path })
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (a.name < b.name ? -1 : 1)
  for (const f of folders.values()) {
    f.folders.sort(byName)
    f.files.sort(byName)
  }
  return top
}

/** The folders that hold `path`, outermost first ('a/b/c.txt' → ['a', 'a/b']). */
export function parentFolders(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/**
 * A path from the node's changes (relative to the git repository) as a path of the Files view
 * (relative to the project folder `inRepo` inside it). Null for a file outside the project folder.
 */
export function projectPath(repoPath: string, inRepo: string): string | null {
  if (!inRepo) return repoPath
  return repoPath.startsWith(`${inRepo}/`) ? repoPath.slice(inRepo.length + 1) : null
}
