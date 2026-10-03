import type { ToolCall } from '@harness/shared'
import { CircleAlertIcon, FilePenIcon, FilePlusIcon, FileSearchIcon, FileTextIcon, FolderSearchIcon, GlobeIcon, LoaderIcon, SearchIcon, TerminalIcon } from 'lucide-react'

const LABEL: Record<string, { icon: typeof SearchIcon; running: string; done: string }> = {
  web_search: { icon: SearchIcon, running: 'Searching', done: 'Searched' },
  web_fetch: { icon: GlobeIcon, running: 'Fetching', done: 'Fetched' },
  read_file: { icon: FileTextIcon, running: 'Reading', done: 'Read' },
  find_files: { icon: FolderSearchIcon, running: 'Finding files', done: 'Found files' },
  search_files: { icon: FileSearchIcon, running: 'Searching files', done: 'Searched files' },
  edit_file: { icon: FilePenIcon, running: 'Editing', done: 'Edited' },
  write_file: { icon: FilePlusIcon, running: 'Writing', done: 'Wrote' },
  shell: { icon: TerminalIcon, running: 'Running', done: 'Ran' },
}

/** Tools that act on one local file. */
const FILE_TOOLS = new Set(['read_file', 'edit_file', 'write_file'])

/** Show local files by name, not by full path. */
const displayInput = (call: ToolCall) =>
  FILE_TOOLS.has(call.name) ? (call.input.split(/[\\/]/).pop() ?? call.input) : call.input

/** The searches and page fetches behind a reply, one collapsible row each. */
export function ToolCalls({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      {calls.map((call) => (
        <ToolCallRow key={call.id} call={call} />
      ))}
    </div>
  )
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const label = LABEL[call.name] ?? { icon: SearchIcon, running: 'Running', done: 'Ran' }
  const Icon = call.status === 'running' ? LoaderIcon : call.status === 'error' ? CircleAlertIcon : label.icon
  const verb = call.status === 'running' ? label.running : call.status === 'error' ? `${label.done} (failed)` : label.done

  return (
    <details className="group rounded-md border bg-muted/40 text-xs">
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-muted-foreground">
        <Icon className={`size-3.5 shrink-0 ${call.status === 'running' ? 'animate-spin' : ''} ${call.status === 'error' ? 'text-destructive' : ''}`} />
        <span className="shrink-0 font-medium">{verb}</span>
        <span className="min-w-0 truncate font-mono text-foreground/80" title={call.input}>{displayInput(call)}</span>
        {call.status === 'done' && call.name === 'web_search' && (
          <span className="ml-auto shrink-0">
            {call.results.length} {call.results.length === 1 ? 'result' : 'results'}
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-1 border-t px-2.5 py-2">
        {call.error && <p className="text-destructive">Error: {call.error.replaceAll('_', ' ')}</p>}
        {call.status === 'running' && <p className="text-muted-foreground">Waiting for results…</p>}
        {(call.status === 'done' || call.output) && call.results.length === 0 && (
          <p className="font-mono break-all text-muted-foreground">{call.name === 'shell' ? `$ ${call.input}` : call.input}</p>
        )}
        {call.output && (
          <pre className="max-h-64 overflow-auto rounded bg-background/60 p-2 font-mono whitespace-pre-wrap break-all text-foreground/80">
            {call.output}
          </pre>
        )}
        {call.results.map((r) => (
          <a
            key={r.url}
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-primary hover:underline"
            title={r.url}
          >
            {r.title || r.url}
          </a>
        ))}
      </div>
    </details>
  )
}
