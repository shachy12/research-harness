import { useEffect } from 'react'
import { Outlet, useParams } from 'react-router'
import { useServerHealth } from '@/api/health'
import { useProjects } from '@/api/queries'
import { ProjectSidebar } from '@/features/projects/ProjectSidebar'
import { rememberProject } from '@/features/projects/lastProject'

// App layout: [projects sidebar] + [main view: a project's graph or a node's chat].
export function AppShell() {
  const health = useServerHealth()
  const status = health.isPending ? 'Connecting…' : health.data ? health.data.model : 'Server not reachable'
  const { projectId } = useParams()
  const project = useProjects().data?.find((p) => p.id === projectId)

  // Reopen this project next time, and name the browser tab after it.
  useEffect(() => {
    if (projectId) rememberProject(projectId)
  }, [projectId])
  useEffect(() => {
    document.title = project ? `${project.name} · Harness` : 'Harness'
  }, [project])

  return (
    <div className="grid h-dvh grid-cols-[auto_minmax(0,1fr)]">
      <ProjectSidebar currentId={projectId} />
      <div className="flex min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-2">
          <span className="grid size-7 place-items-center rounded-md bg-primary font-bold text-primary-foreground">
            ⑂
          </span>
          <span className="font-semibold">Harness</span>
          {project && <span className="truncate text-sm text-muted-foreground">/ {project.name}</span>}
          <span
            className={`ml-auto truncate rounded-full border px-2.5 py-0.5 text-xs ${health.isError ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {status}
          </span>
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
