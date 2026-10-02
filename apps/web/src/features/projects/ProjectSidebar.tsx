import type { ProjectSummary } from '@harness/shared'
import { FolderIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { NewProjectDialog } from './NewProjectDialog'
import { RenameProjectDialog } from './RenameProjectDialog'

const COLLAPSED_KEY = 'harness.sidebarCollapsed'

function initiallyCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** The list of projects, with "New project". Collapses to a thin rail to give the chat more room. */
export function ProjectSidebar({ currentId }: { currentId: string | undefined }) {
  const projects = useProjects()
  const [collapsed, setCollapsed] = useState(initiallyCollapsed)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)

  const toggle = () => {
    setCollapsed(!collapsed)
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '0' : '1')
    } catch {
      // not remembered; fine
    }
  }

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
          {projects.data?.map((p) => (
            <div
              key={p.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                p.id === currentId && 'bg-muted font-medium',
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
              <button
                type="button"
                aria-label={`Rename ${p.name}`}
                title="Rename"
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                onClick={() => setRenaming(p)}
              >
                <PencilIcon className="size-3.5" />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="sm" className="mt-1 justify-start text-muted-foreground" onClick={() => setCreating(true)}>
            <PlusIcon /> New project
          </Button>
        </nav>
      )}

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {renaming && <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />}
    </aside>
  )
}
