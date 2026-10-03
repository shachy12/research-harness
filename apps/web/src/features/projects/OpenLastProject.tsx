import { Navigate } from 'react-router'
import { useProjects } from '@/api/queries'
import { lastProject } from './lastProject'

/** The start page: open the project used last, or the most recently active one. */
export function OpenLastProject() {
  const projects = useProjects()
  if (projects.isError) return <p className="p-6 text-sm text-destructive">Could not load projects: {projects.error.message}</p>
  if (!projects.data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const last = lastProject()
  // The last one used (even if archived since), else the most recent one that isn't archived.
  const target = projects.data.find((p) => p.id === last) ?? projects.data.find((p) => !p.archived) ?? projects.data[0]
  if (!target) return <p className="p-6 text-sm text-muted-foreground">No projects yet. Create one in the sidebar.</p>
  return <Navigate to={`/projects/${target.id}`} replace />
}
