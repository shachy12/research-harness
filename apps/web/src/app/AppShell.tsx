import { Outlet } from 'react-router'
import { useServerHealth } from '@/api/health'

// App layout: [sidebar] + [main view]. The sidebar (projects, settings, …) is added later;
// the grid already reserves its column so the main views don't need to change.
export function AppShell() {
  const serverOk = useServerHealth()

  return (
    <div className="grid h-dvh grid-cols-[auto_minmax(0,1fr)]">
      <aside aria-label="Sidebar" />
      <div className="flex min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-primary font-bold text-primary-foreground">
            ⑂
          </span>
          <span className="font-semibold">Harness</span>
          <span className="ml-auto text-xs text-muted-foreground">
            Server:{' '}
            {serverOk === null ? 'checking…' : serverOk ? 'connected' : 'not reachable'}
          </span>
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
