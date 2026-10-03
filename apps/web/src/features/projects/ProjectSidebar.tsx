import type { ProjectSummary } from '@harness/shared'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  FolderIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useArchiveProject, useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { NewProjectDialog } from './NewProjectDialog'
import { RenameProjectDialog } from './RenameProjectDialog'

const COLLAPSED_KEY = 'harness.sidebarCollapsed'
const ARCHIVES_OPEN_KEY = 'harness.archivesOpen'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // not remembered; fine
  }
}

/**
 * The list of projects, with "New project". Archived projects are in an "Archives" group at the
 * bottom, closed by default. Collapses to a thin rail to give the chat more room.
 */
export function ProjectSidebar({ currentId }: { currentId: string | undefined }) {
  const projects = useProjects()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSED_KEY))
  const [archivesOpen, setArchivesOpen] = useState(() => readFlag(ARCHIVES_OPEN_KEY))
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)

  const toggle = () => {
    setCollapsed(!collapsed)
    writeFlag(COLLAPSED_KEY, !collapsed)
  }
  const toggleArchives = () => {
    setArchivesOpen(!archivesOpen)
    writeFlag(ARCHIVES_OPEN_KEY, !archivesOpen)
  }

  const active = projects.data?.filter((p) => !p.archived) ?? []
  const archived = projects.data?.filter((p) => p.archived) ?? []
  const row = (p: ProjectSummary) => (
    <ProjectRow key={p.id} project={p} current={p.id === currentId} onRename={setRenaming} onDelete={setDeleting} />
  )

  return (
    <aside aria-label="Projects" className={cn('flex min-h-0 flex-col border-r bg-sidebar', collapsed ? 'w-12' : 'w-60')}>
      <div className={cn('flex items-center gap-1 border-b px-2 py-2', collapsed && 'flex-col')}>
        {!collapsed && <span className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Projects</span>}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(!collapsed && 'ml-auto')}
          aria-label="New project"
          title="New project"
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? 'Show projects' : 'Hide projects'}
          title={collapsed ? 'Show projects' : 'Hide projects'}
          onClick={toggle}
        >
          {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
        </Button>
      </div>

      {!collapsed && (
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {projects.isError && <p className="px-2 text-xs text-destructive">{projects.error.message}</p>}
          {active.map(row)}
          <Button variant="ghost" size="sm" className="mt-1 justify-start text-muted-foreground" onClick={() => setCreating(true)}>
            <PlusIcon /> New project
          </Button>

          {archived.length > 0 && (
            <div className="mt-3 flex flex-col gap-0.5 border-t pt-2">
              <button
                type="button"
                aria-expanded={archivesOpen}
                className="flex items-center gap-1 rounded-md px-1 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:bg-muted"
                onClick={toggleArchives}
              >
                <ChevronRightIcon className={cn('size-3.5 transition-transform', archivesOpen && 'rotate-90')} />
                Archives
                <span className="ml-auto font-mono font-normal normal-case">{archived.length}</span>
              </button>
              {archivesOpen && archived.map(row)}
            </div>
          )}
        </nav>
      )}

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {renaming && <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <DeleteProjectDialog
          project={deleting}
          onDeleted={() => {
            if (deleting.id === currentId) navigate('/') // opens another project
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </aside>
  )
}

function ProjectRow({ project: p, current, onRename, onDelete }: {
  project: ProjectSummary
  current: boolean
  onRename: (p: ProjectSummary) => void
  onDelete: (p: ProjectSummary) => void
}) {
  const archive = useArchiveProject()

  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
        current && 'bg-muted font-medium',
        p.archived && 'text-muted-foreground',
      )}
    >
      <Link to={`/projects/${p.id}`} className="flex min-w-0 flex-1 items-center gap-2" title={p.folder ?? undefined}>
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {p.running ? (
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-open" title="Working" />
        ) : (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{p.nodeCount}</span>
        )}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Actions for ${p.name}`}
              title="Rename, archive, delete"
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 data-[popup-open]:opacity-100"
            />
          }
        >
          <EllipsisVerticalIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuItem onClick={() => onRename(p)}>
            <PencilIcon /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => archive.mutate({ projectId: p.id, archived: !p.archived })}>
            {p.archived ? <><ArchiveRestoreIcon /> Unarchive</> : <><ArchiveIcon /> Archive</>}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(p)}>
            <Trash2Icon /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
