import type { BranchResult, DagNode, GraphResponse, MergeBody, NodeDetail } from '@harness/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

// Query keys: what each piece of cached server data is called.
export const keys = {
  graph: (projectId: string) => ['graph', projectId] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
}

export function useGraph(projectId: string) {
  return useQuery({
    queryKey: keys.graph(projectId),
    queryFn: ({ signal }) => api.get<GraphResponse>(`/projects/${projectId}/graph`, signal),
  })
}

export function useNodeDetail(nodeId: string) {
  return useQuery({
    queryKey: keys.node(nodeId),
    queryFn: ({ signal }) => api.get<NodeDetail>(`/nodes/${nodeId}`, signal),
  })
}

/** After any change, refetch the graph and every node detail (cheap at this size, and always correct). */
export function useRefreshAll() {
  const queryClient = useQueryClient()
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['graph'] }),
    queryClient.invalidateQueries({ queryKey: ['node'] }),
  ])
}

export function useFork() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, titles }: { nodeId: string; titles: string[] }) =>
      api.post<DagNode[]>(`/nodes/${nodeId}/fork`, { titles }),
    onSuccess: refresh,
  })
}

export function useDraftResult() {
  return useMutation({
    mutationFn: (nodeId: string) => api.post<BranchResult>(`/nodes/${nodeId}/result/draft`),
  })
}

export function useSaveResult() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, result }: { nodeId: string; result: BranchResult }) =>
      api.put<DagNode>(`/nodes/${nodeId}/result`, result),
    onSuccess: refresh,
  })
}

export function useMerge(projectId: string) {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: (body: MergeBody) => api.post<DagNode>(`/projects/${projectId}/merge`, body),
    onSuccess: refresh,
  })
}

export function useRename() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, title }: { nodeId: string; title: string }) =>
      api.patch<DagNode>(`/nodes/${nodeId}`, { title }),
    onSuccess: refresh,
  })
}
