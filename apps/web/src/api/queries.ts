import type {
  CreateProjectBody,
  DagNode,
  FileContent,
  FolderGit,
  ForkBody,
  GraphResponse,
  MergeBody,
  MergePreview,
  ModelSettingsBody,
  ModelsResponse,
  NodeChanges,
  NodeDetail,
  NodeFiles,
  Project,
  ProjectSummary,
} from '@harness/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from './client'

// Query keys: what each piece of cached server data is called.
export const keys = {
  projects: ['projects'] as const,
  graph: (projectId: string) => ['graph', projectId] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
  models: ['models'] as const,
  changes: (nodeId: string) => ['changes', nodeId] as const,
  files: (nodeId: string) => ['files', nodeId] as const,
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

/** Move a project to the sidebar's Archives group, or back. */
export function useArchiveProject() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ projectId, archived }: { projectId: string; archived: boolean }) =>
      api.patch<Project>(`/projects/${projectId}`, { archived }),
    onSuccess: refresh,
  })
}

/** Delete a project (the server backs up the database first). */
export function useDeleteProject() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: (projectId: string) => api.del<{ ok: true }>(`/projects/${projectId}`),
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
    // Also while a model-written title is on its way, so it shows up without a reload, and while a
    // merge is writing its results.
    refetchInterval: (query) =>
      (query.state.data?.nodes.some((n) => n.running || n.titlePending || n.merge?.running) ? 1500 : false),
  })
}

export function useNodeDetail(nodeId: string, enabled = true) {
  return useQuery({
    queryKey: keys.node(nodeId),
    queryFn: ({ signal }) => api.get<NodeDetail>(`/nodes/${nodeId}`, signal),
    enabled,
    // Opening a chat always loads it fresh, even if it was fetched moments ago (the default
    // staleTime would skip that): the opening scroll position depends on what has been read.
    refetchOnMount: 'always',
    // A merge writing its results starts its reply when they're done: keep checking so the chat sees it.
    refetchInterval: (query) => (query.state.data?.titlePending || query.state.data?.merge?.running ? 1500 : false),
  })
}

/** After any change, refetch the graph and every node detail (cheap at this size, and always correct). */
export function useRefreshAll() {
  const queryClient = useQueryClient()
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.projects }),
    queryClient.invalidateQueries({ queryKey: ['graph'] }),
    queryClient.invalidateQueries({ queryKey: ['node'] }),
    queryClient.invalidateQueries({ queryKey: ['changes'] }),
    queryClient.invalidateQueries({ queryKey: ['files'] }),
  ])
}

/** What creating a project on this folder does in git (empty: nothing to check). */
/** The folder Harness would make for a new project with this name (when no folder is chosen). */
export function useNewFolderPath(name: string, enabled: boolean) {
  return useQuery({
    queryKey: ['new-folder', name],
    queryFn: ({ signal }) => api.get<{ path: string }>(`/projects/new-folder?name=${encodeURIComponent(name)}`, signal),
    enabled,
    staleTime: 0,
    placeholderData: (previous) => previous, // keep the last path while the next one loads
  })
}

export function useCheckFolder(folder: string) {
  return useQuery({
    queryKey: ['check-folder', folder],
    queryFn: ({ signal }) => api.post<FolderGit>('/projects/check-folder', { folder }, signal),
    enabled: folder !== '',
    retry: false,
    staleTime: 0,
  })
}

/**
 * What applying a node's file changes would bring into the project. `version` (its file count and
 * message count) changes after each reply, which loads it again.
 */
export function useNodeChanges(nodeId: string, enabled: boolean, version: string) {
  return useQuery({
    queryKey: [...keys.changes(nodeId), version],
    queryFn: ({ signal }) => api.get<NodeChanges | null>(`/nodes/${nodeId}/changes`, signal),
    enabled,
    staleTime: 0,
  })
}

/**
 * The files of a node's copy (Files view). `version` changes after each reply. Loaded again when
 * the window gets the focus back (`staleTime: 0`), e.g. after editing in VS Code.
 */
export function useNodeFiles(nodeId: string, version: string, enabled = true) {
  return useQuery({
    queryKey: [...keys.files(nodeId), version],
    queryFn: ({ signal }) => api.get<NodeFiles>(`/nodes/${nodeId}/files`, signal),
    enabled,
    staleTime: 0,
    placeholderData: (previous) => previous, // keep the tree while a new version loads
  })
}

/** One file of a node's copy, for the viewer (null path: none chosen). */
export function useFileContent(nodeId: string, path: string | null, version: string) {
  return useQuery({
    queryKey: [...keys.files(nodeId), 'content', path, version],
    queryFn: ({ signal }) => api.get<FileContent>(`/nodes/${nodeId}/files/content?path=${encodeURIComponent(path!)}`, signal),
    enabled: path !== null,
    staleTime: 0,
  })
}

/** Open the node's copy in VS Code (with one of its files). Failures show as a toast. */
export function useOpenInEditor() {
  return useMutation({
    mutationFn: ({ nodeId, path }: { nodeId: string; path?: string }) =>
      api.post<{ ok: true }>(`/nodes/${nodeId}/open-in-editor`, path ? { path } : {}),
    onError: (err) => toast.error(err.message),
  })
}

/** Merge a node's file changes into the project's current branch. */
export function useApplyChanges() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: (nodeId: string) => api.post<{ ok: true }>(`/nodes/${nodeId}/apply`),
    onSettled: refresh,
  })
}

/** What merging these branches does to their files (only asked when some of them edited files). */
export function useMergePreview(projectId: string, parentIds: string[], enabled: boolean) {
  return useQuery({
    queryKey: ['merge-preview', projectId, ...parentIds],
    queryFn: ({ signal }) => api.post<MergePreview>(`/projects/${projectId}/merge/preview`, { parentIds }, signal),
    enabled,
  })
}

export function useFork() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, ...body }: { nodeId: string; branches: ForkBody['branches']; filesFromProject: boolean }) =>
      api.post<DagNode[]>(`/nodes/${nodeId}/fork`, body),
    onSuccess: refresh,
  })
}

/** Answer a node's last message again (its reply failed or was stopped before writing anything). */
/** Allow or deny the ask_node questions a reply waits on (the reply's stream shows the outcome). */
export function useDecideAsks() {
  return useMutation({
    mutationFn: ({ nodeId, allow }: { nodeId: string; allow: boolean }) => api.post(`/nodes/${nodeId}/asks`, { allow }),
  })
}

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

/** Mark a node done (a green marker), or not. Sending it a message clears the mark too. */
export function useSetDone() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId, done }: { nodeId: string; done: boolean }) => api.put<DagNode>(`/nodes/${nodeId}/done`, { done }),
    onSuccess: refresh,
  })
}

/**
 * Delete a node (it is only hidden, with its messages kept). Its children become roots. A toast
 * offers Undo; the graph's "Deleted" list restores it later.
 */
export function useDeleteNode() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: string; title: string }) => api.del<{ ok: true; orphans: string[] }>(`/nodes/${nodeId}`),
    // Not awaited: the deleted node's chat must leave (the caller's onSuccess) before its data is
    // refetched, or the failed refetch replaces the page and the caller's callback never runs.
    onSuccess: (_, { nodeId, title }) => {
      void refresh()
      toast(`Deleted "${title}"`, {
        duration: 10_000,
        action: {
          label: 'Undo',
          onClick: () => {
            api.post(`/nodes/${nodeId}/restore`)
              .then(() => refresh())
              .catch((err: Error) => toast.error(`Could not restore it: ${err.message}`))
          },
        },
      })
    },
  })
}

/** Bring a deleted node back (with its children, if they are still roots). */
export function useRestoreNode() {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: (nodeId: string) => api.post<DagNode>(`/nodes/${nodeId}/restore`),
    onSuccess: refresh,
  })
}

/** Another root in the project: an empty node with no parents. */
export function useNewRoot(projectId: string) {
  const refresh = useRefreshAll()
  return useMutation({
    mutationFn: () => api.post<DagNode>(`/projects/${projectId}/roots`),
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
