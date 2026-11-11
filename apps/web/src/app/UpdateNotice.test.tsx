// @vitest-environment jsdom
import type { VersionInfo } from '@harness/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotice } from './UpdateNotice'

function renderWith(info: VersionInfo) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(info), { status: 200 })))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <UpdateNotice />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UpdateNotice', () => {
  it('says when a newer version is on npm and how to get it', async () => {
    renderWith({ current: '0.2.10', latest: '0.2.11', updateAvailable: true, checkedAt: '2026-11-11T00:00:00.000Z' })
    expect(await screen.findByText('Update available: 0.2.11')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('you have 0.2.10')
    expect(screen.getByRole('button').textContent).toContain('npx research-harness@latest')
  })

  it('shows nothing when up to date or not run from npm', async () => {
    const { container } = renderWith({ current: null, latest: null, updateAvailable: false, checkedAt: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })
})
