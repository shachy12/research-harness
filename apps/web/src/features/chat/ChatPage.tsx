import { Link, useNavigate, useParams } from 'react-router'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

// Placeholder: the full-window chat for one node. Esc or "← Graph" returns to the graph.
export function ChatPage() {
  const { projectId, nodeId } = useParams()
  const navigate = useNavigate()
  const graphUrl = `/projects/${projectId}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate(graphUrl)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, graphUrl])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to={graphUrl} />}>
          ← Graph
        </Button>
        <h1 className="font-semibold">Node {nodeId}</h1>
      </div>
      <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
        Chat view comes next.
      </div>
    </div>
  )
}
