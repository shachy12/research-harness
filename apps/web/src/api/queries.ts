import type {
  BranchResult,
  CreateProjectBody,
  DagNode,
  ForkBody,
  GraphResponse,
  MergeBody,
  ModelSettingsBody,
  ModelsResponse,
  NodeDetail,
  Project,
  ProjectSummary,
} from '@harness/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

// Query keys: what each piece of cached server data is called.
export const keys = {
  projects: ['projects'] as const,
  graph: (projectId: string) => ['graph', projectId] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
  models: ['models'] as const,
}

/**
 * The models the pickers offer. Reloaded now and then: on Claude Code the account's default model
 * can change (e.g. Opus to Sonnet after heavy use), and the labels show the current default.
 */
export function useModels() {
  return useQuery({
    queryKey: keys.models,
    queryFn: ({ signal }) => api.get<ModelsResponse>('/models', signal),
    staleTime: 60_000,
  })
}

/** Change the model and effort a node's next replies use. */
export function useSetNodeModel() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, ...body }: { nodeId: string } & ModelSettingsBody) =>
      api.put<DagNode>(`/nodes/${nodeId}/model`, body),
    onSuccess: refresh,
  })
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: ({ signal }) => api.get<ProjectSummary[]>('/projects', signal),
    // Keep the sidebar's "working" dots current while any project is working.
    refetchInterval: (query) => (query.state.data?.some((p) => p.running) ? 3000 : false),
  })
}

export function useCreateProject() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: (body: CreateProjectBody) => api.post<Project>('/projects', body),
    onSuccess: refresh,
  })
}

export function useRenameProject() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      api.patch<Project>(`/projects/${projectId}`, { name }),
    onSuccess: refresh,
  })
}

/** Open the operating system's folder dialog (on this machine, via the server); null if cancelled. */
export function usePickFolder() {
  return useMutation({
    mutationFn: (startIn?: string) =>
      api.post<{ path: string | null }>('/system/pick-folder', { title: 'Choose the working folder', startIn }),
  })
}

export function useGraph(projectId: string) {
  return useQuery({
    queryKey: keys.graph(projectId),
    queryFn: ({ signal }) => api.get<GraphResponse>(`/projects/${projectId}/graph`, signal),
    // Always reload when the graph opens (a reply may have started meanwhile), and while any node
    // is working, keep refreshing so the cards' "Working…" / "Your turn" stay current.
    staleTime: 0,
    // Also while a model-written title is on its way, so it shows up without a reload.
    refetchInterval: (query) => (query.state.data?.nodes.some((n) => n.running || n.titlePending) ? 1500 : false),
  })
}

export function useNodeDetail(nodeId: string) {
  return useQuery({
    queryKey: keys.node(nodeId),
    queryFn: ({ signal }) => api.get<NodeDetail>(`/nodes/${nodeId}`, signal),
    // Opening a chat always loads it fresh, even if it was fetched moments ago (the default
    // staleTime would skip that): the opening scroll position depends on what has been read.
    refetchOnMount: 'always',
    refetchInterval: (query) => (query.state.data?.titlePending ? 1500 : false),
  })
}

/** After any change, refetch the graph and every node detail (cheap at this size, and always correct). */
export function useRefreshAll() {
  const queryClient = useQueryClient()
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.projects }),
    queryClient.invalidateQueries({ queryKey: ['graph'] }),
    queryClient.invalidateQueries({ queryKey: ['node'] }),
  ])
}

export function useFork() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, branches }: { nodeId: string; branches: ForkBody['branches'] }) =>
      api.post<DagNode[]>(`/nodes/${nodeId}/fork`, { branches }),
    onSuccess: refresh,
  })
}

/** Answer a node's last message again (its reply failed or was stopped before writing anything). */
export function useRetry() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: (nodeId: string) => api.post(`/nodes/${nodeId}/retry`),
    onSettled: refresh,
  })
}

/**
 * Tell the server which reply the user has read up to. Only the graph is refetched (for the "N new"
 * badges); refetching the open chat would just re-send what it already shows.
 */
export function useMarkRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ nodeId, messageId }: { nodeId: string; messageId: string }) =>
      api.put(`/nodes/${nodeId}/read`, { messageId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['graph'] }),
  })
}

export function useSuggestTitle() {
  return useMutation({
    mutationFn: (nodeId: string) => api.post<{ title: string }>(`/nodes/${nodeId}/title/suggest`),
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

export function useResetProject(projectId: string) {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: () => api.post<DagNode>(`/projects/${projectId}/reset`),
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
