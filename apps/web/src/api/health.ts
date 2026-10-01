import { useQuery } from '@tanstack/react-query'
import { api } from './client'

/** Whether the server answers, and which model it uses. */
export function useServerHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.get<{ ok: boolean; model: string }>('/health', signal),
    refetchInterval: 30_000,
  })
}
