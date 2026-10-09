import type { DagNode, FileChange } from '@harness/shared'
import { ChevronRightIcon, ExternalLinkIcon, FileCodeIcon, FileTextIcon, FolderIcon, FolderOpenIcon, ImageIcon, LockIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useFileContent, useNodeChanges, useNodeFiles, useOpenInEditor } from '@/api/queries'
import { Markdown } from '@/features/chat/Markdown'
import { DiffView } from '@/features/editing/ChangesPanel'
import { splitDiff } from '@/lib/diff'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CodeViewer } from './CodeViewer'
import { type TreeFolder, buildTree, parentFolders, projectPath } from './fileTree'
import { type ViewerMode, useFilesViewState } from './viewState'

const STATUS_LETTER: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

/** Trees this small open with every folder expanded. */
const EXPAND_ALL_BELOW = 150

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i
const MODE_LABEL: Record<ViewerMode, string> = { preview: 'Preview', file: 'File', changes: 'Changes' }

/** A file's change compared with the project's branch (what Apply would bring), keyed by project path. */
type ChangeInfo = FileChange & { repoPath: string }

/**
 * The Files view of a node: its copy of the project as a tree, and a read-only viewer with colours
 * per file type, a Markdown file's preview, or the file's changes. Editing happens in VS Code
 * ("Open in VS Code"). How it was left (file, folders, filter, mode) is remembered per node.
 */
export function FilesView({ node, version, linkedFile, onSelect }: {
  node: DagNode
  /** Changes after each reply, so the files are loaded again. */
  version: string
  /** The file named in the page's address (a link or a reload); else the one remembered. */
  linkedFile: string | null
  onSelect: (path: string) => void
}) {
  const files = useNodeFiles(node.id, version)
  const changes = useNodeChanges(node.id, node.gitBranch !== null, version)
  const [view, setView] = useFilesViewState(node.id)
  const { changedOnly } = view
  const open = useOpenInEditor()

  const inRepo = files.data?.inRepo ?? ''
  const changed = useMemo(() => {
    const map = new Map<string, ChangeInfo>()
    for (const f of changes.data?.files ?? []) {
      const p = projectPath(f.path, inRepo)
      if (p !== null) map.set(p, { ...f, repoPath: f.path })
    }
    return map
  }, [changes.data, inRepo])
  const diffs = useMemo(() => (changes.data ? splitDiff(changes.data.diff) : new Map<string, string>()), [changes.data])

  // Deleted files aren't in the copy any more, but their change is worth seeing.
  const deleted = [...changed].filter(([, c]) => c.status === 'deleted').map(([p]) => p)
  const listed = changedOnly ? [...changed.keys()] : [...(files.data?.files ?? []), ...deleted]
  const listedKey = listed.join('\n') // rebuild the tree only when the list changes
  const tree = useMemo(() => buildTree(listedKey ? listedKey.split('\n') : []), [listedKey])

  // The remembered file may be gone since (deleted, or the node's files changed): then none.
  const wanted = linkedFile ?? view.file
  const exists = wanted !== null && (!files.data || files.data.files.includes(wanted) || deleted.includes(wanted))
  const selected = exists ? wanted : null
  const select = (path: string) => {
    setView({ file: path })
    onSelect(path)
  }

  const change = selected ? changed.get(selected) : undefined
  // What this file can show; the mode last picked is used when it can (a deleted file has only its changes).
  const modes: ViewerMode[] = []
  if (selected && MARKDOWN_FILE.test(selected) && change?.status !== 'deleted') modes.push('preview')
  if (change?.status !== 'deleted') modes.push('file')
  if (change) modes.push('changes')
  const mode = modes.includes(view.mode) ? view.mode : modes.includes('file') ? 'file' : modes[0]

  const defaultOpen = (path: string) => changedOnly || listed.length < EXPAND_ALL_BELOW
    || [...changed.keys(), ...(selected ? [selected] : [])].some((p) => parentFolders(p).includes(path))
  const treeProps: TreeProps = {
    changed,
    selected,
    onSelect: select,
    isOpen: (path) => view.folders[path] ?? defaultOpen(path),
    toggle: (path) => setView({ folders: { ...view.folders, [path]: !(view.folders[path] ?? defaultOpen(path)) } }),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
        <LockIcon className="size-3.5" aria-hidden="true" />
        <span>{sourceNote(files.data?.source)}</span>
        {node.gitBranch && <code className="text-[11px]">{node.gitBranch}</code>}
        <span className="ml-auto">Edit in VS Code; tell Claude what you changed.</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
        <nav aria-label="Files" className="flex min-h-0 flex-col border-r">
          <label className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={changedOnly} onChange={(e) => setView({ changedOnly: e.target.checked })} />
            Changed files only{changed.size > 0 && ` (${changed.size})`}
          </label>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3 text-[13px]">
            {files.isPending && <p className="px-2 text-xs text-muted-foreground">Loading files…</p>}
            {files.isError && <p className="px-2 text-xs text-destructive">Could not load the files: {files.error.message}</p>}
            {files.data && listed.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">{changedOnly ? 'No changed files.' : 'No files.'}</p>
            )}
            {files.data && <FolderItems folder={tree} depth={0} tree={treeProps} />}
            {files.data?.truncated && <p className="px-2 pt-2 text-xs text-muted-foreground">Only the first 10,000 files are listed.</p>}
          </div>
        </nav>

        <section aria-label="File" className="flex min-h-0 flex-col">
          {selected === null ? (
            <p className="m-auto p-6 text-sm text-muted-foreground">Pick a file on the left to read it.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
                <span className="min-w-0 truncate font-mono text-xs" title={selected}>{selected}</span>
                {change && <ChangeCounts change={change} />}
                <span className="ml-auto" />
                {modes.length > 1 && (
                  <div className="flex overflow-hidden rounded-md border text-xs" role="group" aria-label="Show">
                    {modes.map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={m === mode}
                        className={cn('px-2.5 py-1', m === mode ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
                        onClick={() => setView({ mode: m })}
                      >
                        {MODE_LABEL[m]}
                      </button>
                    ))}
                  </div>
                )}
                {files.data?.folder && change?.status !== 'deleted' && (
                  <button
                    type="button"
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Open this file in VS Code"
                    title="Open this file in VS Code"
                    onClick={() => open.mutate({ nodeId: node.id, path: selected })}
                  >
                    <ExternalLinkIcon className="size-4" />
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {mode === 'changes' && change ? (
                  <DiffView text={diffs.get(change.repoPath)} fill />
                ) : (
                  <FileBody nodeId={node.id} path={selected} version={version} preview={mode === 'preview'} />
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function sourceNote(source: 'copy' | 'branch' | 'start' | undefined): string {
  if (source === 'branch') return 'Read-only. No reply yet: these are the files it was forked with; its own copy is made with its first reply.'
  if (source === 'start') return 'Read-only. No reply yet: these are the files it will start from; its own copy is made with its first reply.'
  return "Read-only view of this node's copy of the project"
}

function ChangeCounts({ change }: { change: FileChange }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {change.additions === null ? (
        <span className="text-muted-foreground">binary</span>
      ) : (
        <><span className="text-done">+{change.additions}</span> <span className="text-destructive">−{change.deletions}</span></>
      )}
    </span>
  )
}

/** The selected file: its text with colours, its rendered Markdown, an image, or why it can't be shown. */
function FileBody({ nodeId, path, version, preview }: { nodeId: string; path: string; version: string; preview: boolean }) {
  const content = useFileContent(nodeId, path, version)
  if (content.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>
  if (content.isError) return <p className="p-4 text-sm text-destructive">Could not open this file: {content.error.message}</p>
  const file = content.data
  if (file.kind === 'text' && preview) {
    // Rendered like a reply (math included). Images with relative paths aren't shown.
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-5">
          <Markdown text={file.text ?? ''} />
        </div>
      </div>
    )
  }
  if (file.kind === 'text') return <CodeViewer path={path} text={file.text ?? ''} />
  if (file.kind === 'image') {
    return (
      <div className="grid h-full place-items-center overflow-auto bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4">
        <img
          src={`/api/nodes/${nodeId}/files/raw?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`}
          alt={path}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }
  return (
    <p className="p-4 text-sm text-muted-foreground">
      {file.kind === 'binary' ? `A binary file (${formatBytes(file.size)}): it can't be shown as text.` : `Too large to show here (${formatBytes(file.size)}).`}
      {' '}Open it in VS Code to look at it.
    </p>
  )
}

/** What every row of the tree needs: the changes, the open file, and which folders are open. */
interface TreeProps {
  changed: Map<string, ChangeInfo>
  selected: string | null
  onSelect: (path: string) => void
  isOpen: (folder: string) => boolean
  toggle: (folder: string) => void
}

function FolderItems({ folder, depth, tree }: { folder: TreeFolder; depth: number; tree: TreeProps }) {
  const { changed, selected, onSelect } = tree
  const indent = { paddingLeft: `${depth * 14 + 6}px` }
  return (
    <ul>
      {folder.folders.map((f) => (
        <FolderRow key={f.path} folder={f} depth={depth} tree={tree} />
      ))}
      {folder.files.map((f) => {
        const change = changed.get(f.path)
        const Icon = fileIcon(f.name)
        return (
          <li key={f.path}>
            <button
              type="button"
              style={indent}
              aria-current={f.path === selected ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left',
                f.path === selected ? 'bg-open-soft text-open' : 'hover:bg-muted',
              )}
              title={f.path}
              onClick={() => onSelect(f.path)}
            >
              <span className="w-3.5 shrink-0" aria-hidden="true" />
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className={cn('min-w-0 truncate', change?.status === 'deleted' && 'text-muted-foreground line-through')}>{f.name}</span>
              {change && (
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded px-1 font-mono text-[10px] font-semibold',
                    change.status === 'added' ? 'bg-done-soft text-done' : change.status === 'deleted' ? 'bg-destructive/10 text-destructive' : 'bg-merge-soft text-merge',
                  )}
                  title={`${change.status} compared with the project's branch`}
                >
                  {STATUS_LETTER[change.status]}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function FolderRow({ folder, depth, tree }: { folder: TreeFolder; depth: number; tree: TreeProps }) {
  const open = tree.isOpen(folder.path)
  const Icon = open ? FolderOpenIcon : FolderIcon
  return (
    <li>
      <button
        type="button"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left hover:bg-muted"
        onClick={() => tree.toggle(folder.path)}
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{folder.name}</span>
      </button>
      {open && <FolderItems folder={folder} depth={depth + 1} tree={tree} />}
    </li>
  )
}

const CODE_FILE = /\.(py|ipynb|js|jsx|ts|tsx|mjs|cjs|c|h|cc|cpp|hpp|rs|go|java|kt|rb|php|cs|swift|sh|bash|ps1|r|jl|m|scala|lua|sql|json|yaml|yml|toml|xml|html|css|scss|vue|svelte)$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i

function fileIcon(name: string) {
  if (IMAGE_FILE.test(name)) return ImageIcon
  if (CODE_FILE.test(name)) return FileCodeIcon
  return FileTextIcon
}
