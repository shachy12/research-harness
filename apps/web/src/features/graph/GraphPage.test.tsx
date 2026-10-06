// @vitest-environment jsdom
import type { GraphResponse, NodeSummary } from '@harness/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphPage } from './GraphPage'
import { rememberView, rememberedView } from './viewMemory'

// What React Flow needs from the browser that jsdom doesn't have.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia
  // @ts-expect-error a minimal stand-in: React Flow reads only m22 (the zoom) from it
  window.DOMMatrixReadOnly = class {
    m22: number
    constructor(transform?: string) {
      this.m22 = Number(/scale\(([\d.]+)\)/.exec(transform ?? '')?.[1] ?? 1)
    }
  }
})

const node = (id: string, projectId: string): NodeSummary => ({
  id, projectId, title: `Node ${id}`, titleSource: 'prompt', promptTitle: `Node ${id}`, parentIds: [], forkPoint: null,
  forkSession: null, status: 'open', result: null, resultUpto: null, mergeResults: null, mergePrompt: null,
  filesFromProject: false, sessionId: null, readUpto: null, model: null, effort: null, gitBranch: null, filesChanged: null,
  createdAt: '2026-10-06T00:00:00.000Z', messageCount: 0, lastMessage: null, lastRole: null, unread: 0, running: false,
  run: null, titlePending: false, proposedBranches: 0, forkedAtEnd: false, merge: null,
})

const graphOf = (projectId: string): GraphResponse => ({
  project: { id: projectId, name: projectId, folder: null, archived: false, createdAt: '2026-10-06T00:00:00.000Z' },
  nodes: [node(`${projectId}-root`, projectId)],
  usage: null,
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const projectId = /\/api\/projects\/([^/]+)\/graph/.exec(url)?.[1]
    return new Response(JSON.stringify(projectId ? graphOf(projectId) : {}), { status: projectId ? 200 : 404 })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Lets the test switch projects the way the sidebar does: same page, another URL. */
let go: (path: string) => void = () => {}
function Navigator() {
  const navigate = useNavigate()
  useEffect(() => {
    go = (path) => navigate(path)
  }, [navigate])
  return null
}

function renderGraph(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Navigator />
        <Routes>
          <Route path="/projects/:projectId" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The pan/zoom React Flow shows, read from its viewport element's transform. */
function shownView(container: HTMLElement) {
  const transform = container.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? ''
  const [, x, y, zoom] = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform) ?? []
  return { x: Number(x), y: Number(y), zoom: Number(zoom) }
}

describe('graph view', () => {
  it('keeps each project’s own pan and zoom when switching between projects', async () => {
    rememberView('alpha', { viewport: { x: 10, y: 20, zoom: 1.5 }, nodeCount: 1 })
    rememberView('beta', { viewport: { x: -30, y: 40, zoom: 0.5 }, nodeCount: 1 })

    const { container } = renderGraph('/projects/alpha')
    await waitFor(() => expect(container.querySelector('.react-flow__node')).not.toBeNull())
    expect(shownView(container)).toEqual({ x: 10, y: 20, zoom: 1.5 })

    act(() => go('/projects/beta'))
    await waitFor(() => expect(container.textContent).toContain('Node beta-root'))
    expect(shownView(container)).toEqual({ x: -30, y: 40, zoom: 0.5 })

    act(() => go('/projects/alpha'))
    await waitFor(() => expect(container.textContent).toContain('Node alpha-root'))
    expect(shownView(container)).toEqual({ x: 10, y: 20, zoom: 1.5 })
    // Showing one project never overwrote the other's view.
    expect(rememberedView('alpha')?.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
    expect(rememberedView('beta')?.viewport).toEqual({ x: -30, y: 40, zoom: 0.5 })
  })

  it('remembers views across reloads', () => {
    rememberView('gamma', { viewport: { x: 1, y: 2, zoom: 0.8 }, nodeCount: 3 })
    expect(JSON.parse(localStorage.getItem('harness.graphViews')!).gamma).toEqual({ viewport: { x: 1, y: 2, zoom: 0.8 }, nodeCount: 3 })
  })
})
