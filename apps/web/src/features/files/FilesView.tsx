import type { DagNode, FileChange } from '@harness/shared'
import { ChevronRightIcon, ExternalLinkIcon, FileCodeIcon, FileTextIcon, FolderIcon, FolderOpenIcon, ImageIcon, LockIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useFileContent, useNodeChanges, useNodeFiles, useOpenInEditor } from '@/api/queries'
import { DiffView } from '@/features/editing/ChangesPanel'
import { splitDiff } from '@/lib/diff'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CodeViewer } from './CodeViewer'
import { type TreeFolder, buildTree, parentFolders, projectPath } from './fileTree'

const STATUS_LETTER: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

/** Trees this small open with every folder expanded. */
const EXPAND_ALL_BELOW = 150

/** A file's change compared with the project's branch (what Apply would bring), keyed by project path. */
type ChangeInfo = FileChange & { repoPath: string }

/**
 * The Files view of a node: its copy of the project as a tree, and a read-only viewer with colours
 * per file type, or the file's changes. Editing happens in VS Code ("Open in VS Code").
 */
export function FilesView({ node, version, selected, onSelect }: {
  node: DagNode
  /** Changes after each reply, so the files are loaded again. */
  version: string
  selected: string | null
  onSelect: (path: string) => void
}) {
  const files = useNodeFiles(node.id, version)
  const changes = useNodeChanges(node.id, node.gitBranch !== null, version)
  const [changedOnly, setChangedOnly] = useState(false)
  const [mode, setMode] = useState<{ path: string | null; diff: boolean }>({ path: null, diff: false })
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

  const change = selected ? changed.get(selected) : undefined
  // A deleted file has only its change to show; any other changed file opens on its contents.
  const showDiff = change !== undefined && (change.status === 'deleted' || (mode.path === selected && mode.diff))

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
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
            Changed files only{changed.size > 0 && ` (${changed.size})`}
          </label>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3 text-[13px]">
            {files.isPending && <p className="px-2 text-xs text-muted-foreground">Loading files…</p>}
            {files.isError && <p className="px-2 text-xs text-destructive">Could not load the files: {files.error.message}</p>}
            {files.data && listed.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">{changedOnly ? 'No changed files.' : 'No files.'}</p>
            )}
            {files.data && (
              <FolderItems
                key={changedOnly ? 'changed' : 'all'}
                folder={tree}
                depth={0}
                changed={changed}
                selected={selected}
                onSelect={onSelect}
                initiallyOpen={(path) => changedOnly || listed.length < EXPAND_ALL_BELOW
                  || [...changed.keys(), ...(selected ? [selected] : [])].some((p) => parentFolders(p).includes(path))}
              />
            )}
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
                {change && change.status !== 'deleted' && (
                  <div className="flex overflow-hidden rounded-md border text-xs" role="group" aria-label="Show">
                    {(['File', 'Changes'] as const).map((label) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={(label === 'Changes') === showDiff}
                        className={cn('px-2.5 py-1', (label === 'Changes') === showDiff ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
                        onClick={() => setMode({ path: selected, diff: label === 'Changes' })}
                      >
                        {label}
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
                {showDiff ? (
                  <DiffView text={diffs.get(change.repoPath)} fill />
                ) : (
                  <FileBody nodeId={node.id} path={selected} version={version} />
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

/** The selected file: its text with colours, an image, or why it can't be shown. */
function FileBody({ nodeId, path, version }: { nodeId: string; path: string; version: string }) {
  const content = useFileContent(nodeId, path, version)
  if (content.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>
  if (content.isError) return <p className="p-4 text-sm text-destructive">Could not open this file: {content.error.message}</p>
  const file = content.data
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

function FolderItems({ folder, depth, changed, selected, onSelect, initiallyOpen }: {
  folder: TreeFolder
  depth: number
  changed: Map<string, ChangeInfo>
  selected: string | null
  onSelect: (path: string) => void
  initiallyOpen: (path: string) => boolean
}) {
  const indent = { paddingLeft: `${depth * 14 + 6}px` }
  return (
    <ul>
      {folder.folders.map((f) => (
        <FolderRow key={f.path} folder={f} depth={depth} changed={changed} selected={selected} onSelect={onSelect} initiallyOpen={initiallyOpen} />
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

function FolderRow({ folder, depth, ...rest }: {
  folder: TreeFolder
  depth: number
  changed: Map<string, ChangeInfo>
  selected: string | null
  onSelect: (path: string) => void
  initiallyOpen: (path: string) => boolean
}) {
  const [open, setOpen] = useState(() => rest.initiallyOpen(folder.path))
  const Icon = open ? FolderOpenIcon : FolderIcon
  return (
    <li>
      <button
        type="button"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left hover:bg-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{folder.name}</span>
      </button>
      {open && <FolderItems folder={folder} depth={depth + 1} {...rest} />}
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
