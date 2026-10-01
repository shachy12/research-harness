import { Link, useParams } from 'react-router'
import { Button } from '@/components/ui/button'

// Placeholder: the React Flow graph replaces this in the next step.
export function GraphPage() {
  const { projectId } = useParams()

  return (
    <div className="grid h-full place-items-center p-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold">Graph view</h1>
        <p className="text-sm text-muted-foreground">Project: {projectId}</p>
        <Button nativeButton={false} render={<Link to={`/projects/${projectId}/nodes/root`} />}>
          Open the root node
        </Button>
      </div>
    </div>
  )
}
