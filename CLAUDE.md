# Harness — DAG-based LLM research chat

## Concept
A chat harness where a conversation is a DAG instead of a linear thread, matching a research workflow:

1. Start with a **root node** (a normal chat).
2. **Fork** a node into N child branches. Each child inherits the full context of its parent.
3. Work each branch as a short sub-research task.
4. **Finish** a branch → produce a **result** (a distilled report, not the transcript).
5. **Merge** several finished branches into one new node whose context is
   `[ancestor context up to the fork point] + [result(B1)..result(Bn)] + [optional user framing]`.
   Only results flow back, never the branch transcripts.
6. Continue the DAG from the merged node.

## Design decisions (so far)
- **Immutable, append-only graph.** `Node { id, parentIds[], messages[], status: open|finished, result? }`. Never mutate history; an edit creates a new node. A node's prompt is built by walking its ancestors.
- **Parent freezes once forked** (at least initially), so merges are never ambiguous.
- **Merge base** = the fork node; for nested or cross-fork merges, use the lowest common ancestor.
- **Results are first-class, editable artifacts.** The LLM drafts a structured report (findings, evidence/sources, open questions, confidence), the user edits/approves it, and the frozen result is what gets merged. Keep source citations from tool use; drop raw tool outputs.
- **Prompt caching:** structure prompts so inherited ancestor context is a stable, cacheable prefix, which makes sibling branches cheap.
- **Model providers are pluggable.**
- **Tools are available in every branch** (same tool set everywhere), provided via MCP.

## Stack (decided)
TypeScript end to end, on Node. Chosen over Python + FastAPI because Electron is already Node: there's no second runtime to bundle (PyInstaller), spawn, or manage, and types are shared between backend and frontend.

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere |
| Backend | Node with Hono (local server first, later moved into the Electron main process) |
| LLM providers | Our own `LLMProvider` interface (`apps/server/src/llm/provider.ts`); each provider is an adapter on its official SDK. Claude: `@anthropic-ai/sdk` |
| Tools | MCP client; tools are MCP servers (any language, so Python tools are fine as MCP servers) |
| Storage | SQLite via Node's built-in `node:sqlite`, plain SQL in one repository module |

Changed during the MVP (2026-10-01):
- **Vercel AI SDK → own provider interface + official SDKs.** Claude is called through the official Anthropic SDK (direct access to prompt caching, structured outputs, refusal fallbacks). Providers stay pluggable through `LLMProvider`.
- **Drizzle + better-sqlite3 → `node:sqlite`.** No native module to rebuild for Electron, and npm 12 blocks install scripts by default. Four tables and simple queries don't need an ORM. Verify `node:sqlite` is available in Electron's bundled Node when we get there; the repository module is the only place to change if not.

## Providers
Chosen with `HARNESS_PROVIDER` in `.env`: `claude-code` (the user's choice for their own research: runs on their Claude subscription), `anthropic` (API key, pay per token), or `placeholder`.

Why Claude Code: Anthropic's terms don't allow Claude.ai subscription logins in third-party apps (no "Sign in with Claude", no reusing OAuth tokens). Running the official Claude Code CLI on your own machine is allowed; background runs (`claude -p`) count against a separate monthly credit included with Pro/Max (since 2026-06-15). The API stays available as a provider.

### Claude Code provider (`apps/server/src/llm/claude-code.ts`)
- Each node gets one long-lived `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` process; user messages go to stdin as `{"type":"user","message":{"role":"user","content":...}}` lines, each turn ends with a `result` event. The process is stopped after 10 minutes idle, on Stop (abort), and when the node is forked or finished (`release`). The next message restarts it with `--resume`.
- A node's Claude Code session id is stored in `nodes.session_id` (from the `system:init` event). `dag/session.ts` `planSession` decides how a node's first message starts: `resume` its own session, `fork` the parent's (merge: the base's) session with `--resume X --fork-session`, or `new`. The branch note / merge results go in front of the first message. If there is no session to fork from (e.g. nodes made with another provider), the earlier context is sent as a rendered transcript.
- Tools: `--tools WebSearch,WebFetch,Read,Glob,Grep`, but only `--allowedTools WebSearch,WebFetch` are pre-approved. Read/Glob/Grep work inside the working folder by Claude Code's default permissions; a read outside it needs approval, which `-p` mode refuses (verified 2026-10-02: it shows up as a permission denial). So the model can read the project folder and nothing else. Our `SYSTEM_PROMPT` replaces Claude Code's default (`--system-prompt`); `--setting-sources ''` and `--strict-mcp-config` ignore the user's own Claude Code settings, memory and MCP servers.
- Runs happen in the project's working folder (`ReplyContext.workDir`). Claude Code keeps sessions per folder, so sessions only resume from the folder that created them; migration 4 cleared the older session ids (made in a shared folder), and `planSession`'s transcript fallback takes over for those nodes. If a project's folder ever changes, clear its nodes' session ids the same way.
- Result drafts: a one-shot run with `--resume <node session> --fork-session --no-session-persistence --output-format json --json-schema …`; the answer is in `structured_output`. The CLI rejects the `$schema` line zod adds to JSON Schemas, so it is stripped.
- Tool calls come from `assistant`/`tool_use` (WebSearch `input.query`, WebFetch `input.url`) and `user`/`tool_result` blocks; search result links are parsed from the `Links: [...]` JSON in the result text.
- Windows notes: the npm package's postinstall (which places `claude.exe`) is blocked by npm 12; run `node install.cjs` in the package folder once. `findClaudeExecutable` uses `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` directly (the `claude.ps1` shim is blocked by the PowerShell policy). Windows PowerShell drops empty-string arguments to native programs, so test the CLI from Node, not PowerShell.
- Tests use `llm/fake-claude.mjs`, a fake CLI speaking the same protocol (including a usage-limit hit and a warning).
- Errors: `llm/errors.ts` `classifyError` turns CLI/API failures into a `ProviderError` with `kind` (`usage_limit` | `auth` | `billing` | `other`) and a user-facing message. The CLI reports the limit with `rate_limit_event` lines (`rate_limit_info: { status: allowed | allowed_warning | rejected, resetsAt (Unix s), rateLimitType: five_hour | seven_day, utilization (0–1, sent with warnings) }`), an `error` field on the assistant message ("rate_limit", text "You've hit your limit · resets …"), and a failed `result`. Shapes read from the installed CLI 2.1.287, not yet from a real limit hit. A failed turn kills the node's process so a retry starts clean.
- Titles: `suggestTitle` runs `claude -p --model haiku --no-session-persistence --tools ''` (API provider: one Haiku 4.5 request).

## Model settings (anthropic provider)
- Default model `claude-opus-5-5`, effort `high` (Opus 5.5's own default is `medium`, so it is set explicitly). Override with `HARNESS_MODEL` / `HARNESS_EFFORT`.
- Requests use the server-side refusal fallback (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`).
- Thinking is always on for Opus 5.5 and its text is not shown; the chat stream sends a `thinking` event so the UI can show a "Thinking…" state.
- Without `ANTHROPIC_API_KEY`, the server uses `PlaceholderProvider`, which streams an explanation instead of failing. A message containing "search" makes it show a sample search, to test the tool display.
- Web research: every chat request includes Anthropic's server-side tools `web_search_20260209` and `web_fetch_20260209` (max 10 uses each per reply; they include dynamic filtering, so don't add a separate `code_execution` tool). `pause_turn` is resumed by sending the paused assistant content back unchanged (up to 5 times). Result drafts run without tools.
- Tool calls are stored per message (`messages.tool_calls`, JSON `ToolCall[]`: query or URL, status, result titles/URLs) and streamed as `tool` events. Raw search results are not kept in history; instead each assistant turn in later prompts ends with a `[Sources consulted for this reply: …]` list (`withSources` in `dag/prompt.ts`), so follow-ups and result drafts can cite them.

## Prompt construction (apps/server/src/dag)
- One fixed system prompt for every node. Node-specific framing goes into the conversation: a `[A new branch starts here: …]` user turn where a branch begins, and a `[Merge node …]` user turn carrying the branch results.
- Cache breakpoint on the last inherited turn (siblings share it) plus top-level automatic caching for the growing conversation.
- Merge base = lowest common ancestor of the merged branches. Merged branches contribute only `formatResult(...)` text.
| Frontend | React + Vite |
| Graph view | React Flow |
| UI components | shadcn/ui + Tailwind |
| Desktop | Electron + electron-builder (web UI first, then wrap in Electron) |

## GUI (decided)
Clickable mockup: `mockups/gui-mockup.html` (published at https://claude.ai/artifact/B2ZDmYmj6V8C8tnf7nGw13).

- **Main window = the graph.** Nodes are cards (status chip, title, last message or result summary, message count). Auto-laid out top to bottom; pan and zoom; Fit button.
- **Clicking a node opens its chat full-window**, replacing the graph (a view switch, not a dialog or side panel). The header has a "← Graph" button (and Esc) plus a breadcrumb of ancestors. Returning to the graph keeps the previous pan/zoom.
- Chat view: inherited context collapsed at the top (message count and token estimate), collapsible tool calls, the result block once finished, a composer, and Fork / Finish branch actions.
- Fork: a dialog where you write each branch's first message (starts with one field; + Add branch for more; forking an already-forked node again adds more children); the branch title is derived from it (`titleFromPrompt`, first line, ~80 chars). Creating the branches starts all of them working in parallel, then returns to the graph.
- Activity indicator on open nodes (graph cards and chat header): "Working…" while the model replies, "● Your turn" when waiting for you, "! No reply" if the last message is yours and nothing is running (failed or stopped early). Forked/finished nodes show their status instead. The graph refreshes every 1.5 s while any node is working.
- Finish: the LLM drafts the result (Findings / Evidence & sources / Open questions / Confidence); the user edits and approves it.
- Merge: right-click finished nodes in the graph to toggle them for merge (the card shows a "Selected for merge" badge; right-clicking an unfinished node shakes it and shows a hint), then "Merge selected" opens a preview (base context + results, tokens saved compared with full transcripts, title, framing prompt), then opens the new merged node.
- Edges: solid = inherits full context; dashed with a "result" label = merge edge that passes only the result.
- Considered and dropped: a split view (graph + side chat), and a canvas where every node is an inline chat.

### Projects
- Several projects, each its own graph (own root, nodes, folder). Sidebar (`features/projects/ProjectSidebar.tsx`, collapsible, remembered in localStorage) lists them most recently used first, with node counts and a dot while working; `+` / "New project" opens `NewProjectDialog`, the pencil renames.
- API: `GET /projects` (`ProjectSummary[]`), `POST /projects` `{ name, folder? }` (new id, root "Main thread"), `PATCH /projects/:id` `{ name }`. No delete on purpose (it would remove research; add it later with a backup first).
- `/` opens the last project (`lastProject.ts`, localStorage) or the most recently used one. The server only creates the `default` project when there are no projects at all.
- A folder chosen at creation (`Workspaces.checkFolder`: full path, existing, not a drive root, not inside the data folder) is fixed: Claude Code sessions belong to their folder.
- "Browse…" calls `POST /system/pick-folder`, which opens the OS's own folder dialog on this machine (`system/folder-picker.ts`; a web page can't get real paths): Windows uses the Explorer dialog (IFileOpenDialog via C# in `powershell -EncodedCommand`, owned by an invisible topmost window so it opens in front), macOS `osascript choose folder`, Linux zenity/kdialog. One dialog at a time. In Electron, `dialog.showOpenDialog` replaces it. Tests only compile the Windows code (`checkWindowsPicker`) so no dialog pops up.

### Project folders and attachments (`apps/server/src/workspace.ts`)
- Each project has a working folder: `projects.folder` (chosen when creating the project), or by default `<data>/projects/<id>/`. Managed data lives in `<folder>/.harness/` (with a `.gitignore` of `*`); uploads go to `.harness/uploads/` under safe, unique names (`paper.pdf`, `paper-2.pdf`).
- `POST /projects/:id/uploads` (multipart field `file`, max 50 MB) returns an `Attachment { name, path, size }`. Messages carry `attachments`; the server only accepts existing files in that project's uploads folder (`Workspaces.validate`).
- Files are not inlined: `withAttachments` adds `[The user attached a file. Read it with the Read tool before answering: <absolute path>]` to the message (also in replayed history). Once read, the content is in the Claude Code session, so later forks inherit it without reading again (verified). The API provider has no Read tool, so attachments are Claude Code only for now.
- Folders: `POST /projects/:id/uploads/folder` (fields `name`, then `path` + `file` pairs) copies a folder with its structure to `.harness/uploads/<name>/` (unique name, every path part made safe, so nothing lands outside it). Limits: 2,000 files, 200 MB. Hidden entries (`.git`, …), `node_modules`, `__MACOSX` are skipped (`isSkippedUploadName`). A folder attachment has `kind: 'folder'` and `fileCount`; the message note tells Claude to list it with Glob and read the relevant files (verified with a real LaTeX project).
- Composer: one paperclip (`AttachMenu`) with a "Files… / Folder…" menu (a browser can't pick both in one dialog; the folder picker is `<input webkitdirectory>`, grouped by `groupPickedFolder`), or drop files and folders on the chat (`useDropZone` → `readDrop`, which walks the dropped folder tree via `webkitGetAsEntry`/`readEntries` and must start during the drop event).
- Fork dialog: each branch has its own attach menu and drop zone (`BranchField` with its own `useAttachments`); `forkSchema` is `branches: { prompt, attachments }[]` and the server validates each branch's files. Each item uploads immediately and shows as a chip ("thesis/ · 23 files · 1.2 MB"); Send waits for uploads. Sent messages show their attachments; file reads show as tool rows ("Read draft.tex", "Found files").
- `HARNESS_DATA_DIR` sets the data folder (database + default project folders); the browser-pane preview uses `data/preview/`.

### Usage limit, retry, titles (`runs.ts`)
- `RunManager` keeps the account's usage limit (`usage()`: `warning` | `reached`, `resetsAt`, `limitType`, `utilization`), from the provider's `limit` events and classified failures; a successful reply clears `reached`. It is in `GraphResponse.usage` / `NodeDetail.usage`; error events carry `kind` and `resetsAt`.
- `POST /nodes/:id/retry` answers the node's last (unanswered) user message again without saving a new one (`planSession(..., { retry: true })`). A run's session id is saved only if the reply produced something (or succeeded), so a first reply that failed early leaves no session and the retry starts that conversation over.
- UI: `UsageBanner` on the graph and in chats ("25% of your Claude weekly limit used" with a bar; it stands out from 75% or when the share is unknown), "! Limit reached" chips instead of "! No reply" while the limit is reached, a Retry box under an unanswered message, and "Retry all" on the graph.
- Titles: `nodes.title_source` (`prompt` | `model` | `user`) and `nodes.prompt_title` (migration 5). Prompts always use `promptTitle` (the title at creation), so renaming never changes the model's context or its cache. After a node's first reply, `maybeTitle` asks the provider for a 3–7 word title (only over `prompt` titles; `cleanTitle` tidies it); `titlePending` keeps the graph/chat polling until it lands. Rename (`PATCH`, sets `user`) from the pencil on cards and in the chat header; the rename dialog's Suggest calls `POST /nodes/:id/title/suggest` (not saved). A merge sent without a title gets `defaultMergeTitle` with source `prompt`.
- Placeholder test triggers: `[test:limit]` in a message acts as a reached limit, `[test:warning]` as a warning; replies echo the message so Markdown/math can be checked.

### Fork from list items, table rows and sections
- In a saved assistant reply (`Markdown` with a `messageId`), click a list item or a table body row to pick it for a fork, click again to drop it. No checkbox: hover shows a grey highlight, picked ones are blue (`SelectableListItem` / `SelectableTableRow` in `SelectableItem.tsx`, shared behaviour in `useSelectable`). Only the innermost item or row under the pointer reacts (`data-selectable`). A click is ignored when it ends a text selection (drag to copy), lands on a link/button, or is the second click of a double-click (which undoes the first, so selecting a word leaves the item as it was). Header rows aren't pickable (detected by `td` cells).
- The picked items live in `listSelection.ts` (state in `ChatView`, shared by context). An action bar (`SelectionBar`, above the composer) offers "⑂ Fork…" and "Clear"; Esc clears the selection before leaving the chat. Not done: keyboard picking (rows and items aren't focusable).
- Items are located by react-markdown's `node.position` offsets into the exact string rendered (`prepareMath(text)`), so `Markdown` slices the same string. A list item's text is `itemSource` (drops the marker, de-indents what is under it). A table row's text is `tableRowItem`: one `Column: cell` line per cell (header found by scanning back to the delimiter row; cells beyond the header are ignored like GFM does; empty cells left out), and its title is the first cell. Everything is in `lib/listItems.ts`.
- Sections: `lib/sections.ts` `rehypeSections` (a rehype plugin, only on saved replies) wraps the reply's top-level blocks in `<section>` elements: a heading runs to the next heading of the same or a higher level (so sections nest), a bold lead-in line (a paragraph that is only bold text, optional trailing `:`/`.`, e.g. `**1. Reduce to linear.**`) runs to the next lead-in line or any heading. Bold lines inside lists don't count. The head gets `data-section-head`; `SelectableSection` reacts only to clicks and hover on its head (`useSelectable`'s `handle`), and highlights the whole section. Its text is the section's Markdown as written (`sectionItem`), its title the heading without marks or numbering. Items inside a picked section count as included, like sub-items.
- Picking an item takes its sub-items with it; a picked item inside another picked item (also a row inside a picked list item) is "included" and not a branch of its own (`resolveSelection`); picking only a child gives just the child. Picks can span several lists, tables and replies, in reading order.
- The fork dialog (`ForkDialog`, `items` prop) shows one shared instruction ("what should each branch do with its item?"); each branch's first message is `composeBranchPrompt(instruction, item)` (the item goes where `{item}` is, else after the instruction; empty instruction: the item alone). A branch's message follows the instruction until edited by hand ("Reset" returns it). Remove a branch with its X; "+ Add branch" adds a hand-written one.
- Branch titles come from the items: `forkSchema` branches take an optional `title` (else `titleFromPrompt(prompt)`); `SelectedItem.title` (a row's first cell) or `itemTitle` of the text (Markdown marks stripped).
- Testing it needs layout and real events: use headless Chrome over the DevTools protocol (see "Read position"), with real mouse events (`Input.dispatchMouseEvent` with `clickCount`) for clicks, double-clicks and drags; the hidden Browser pane can't drive it reliably. Don't open a real project's chat to test: it marks replies read. Copy the reply text into a scratch project instead (the placeholder provider renders your message back).

### Read position (`nodes.read_upto`, migration 6)
- Each node stores the id of the last message the user has read. `PUT /nodes/:id/read` `{ messageId }` only moves it forward (`Repository.markRead`) and only to a message of that node. Migration 6 marked every existing node fully read (so nothing was flagged on upgrade); new nodes start with NULL = never opened.
- `NodeSummary.unread` (assistant replies after `readUpto`, `unreadCount` in shared `unread.ts`) drives the "N new" badge on graph cards. `firstUnreadIndex` finds where to scroll.
- `features/chat/useChatScroll.ts` (one instance per node): opening position decided once (never opened → top; unread replies → top of the first unread reply; all read → end); a reply counts as read once its end marker (`data-read-marker`, an IntersectionObserver rooted in the chat's scroller) has been on screen, and never while the tab is hidden; while a reply streams the view follows it only if the user was already at the bottom, and sending a message always jumps to the bottom. `ChatView` waits for freshly fetched node data so a cached copy can't pick the wrong position: `useNodeDetail` has `refetchOnMount: 'always'` (the app-wide `staleTime` of 10 s would otherwise skip the fetch when a node is reopened quickly), and the page waits only while that fetch is running (`!isFetchedAfterMount && isFetching`), never for a fetch that isn't happening (that left reopened nodes stuck on "Loading…", fixed 2026-10-02).
- Testing it: the Browser pane is a hidden document (`document.hidden`), where IntersectionObserver never fires, so the read tracking can't be checked there. Drive a headless Chrome over the DevTools protocol instead (Node 24 has a global `WebSocket`); fetch the API through the Vite proxy (`/api/...`), not port 8790 directly (CORS).

### Replies run on the server (`apps/server/src/runs.ts`)
- `RunManager` runs one reply per node at a time, independent of any open page, and saves it when done (or what arrived, on failure/Stop). Fork and merge start their nodes' first messages through it.
- `POST /nodes/:id/messages` starts a reply and streams it (`user`, then live events). `GET /nodes/:id/stream` attaches to a running reply (`snapshot` of the reply so far, then live events; `idle` if nothing runs). `POST /nodes/:id/stop` stops it. Disconnecting only stops watching.
- `watchRun` subscribes synchronously when the request arrives (not inside the SSE callback), so a fast reply can't finish unseen.
- `NodeSummary.running` / `lastRole` and `NodeDetail.running` drive the activity indicators; the chat page attaches automatically when it opens a running node.
- `run: { startedAt, activity }` (from `RunManager.status`) shows progress: graph cards and the chat header show "Working · 1:42", cards show the current activity ("Searching the web: …", "Reading main.tex", "Thinking", "Writing"; wording from `toolActivity` in shared). Long research turns (several minutes on Opus) must visibly keep moving.
- Attaching is an effect with a cleanup (`stream.attach()` returns the stop function; `useEffectEvent` reads the latest values). Don't guard it with an "already attached" ref: React's development double mount cancels the first watch, and a ref-guarded effect never reattaches (this left forked branches on "Waiting for the model…" — fixed 2026-10-02).

### Web implementation notes
- Server data goes through TanStack Query hooks in `apps/web/src/api/queries.ts`; after any change `useRefreshAll()` refetches the graph and node details.
- Chat streaming: `streamChat()` (send) and `watchChat()` (attach) in `api/client.ts` read the server-sent events; `features/chat/useChatStream.ts` holds the live state (`send`, `watch`, `stop`). Leaving the page only stops watching; Stop calls the server's stop endpoint.
- Graph: React Flow with fixed-size cards (`CARD_WIDTH`/`CARD_HEIGHT`) laid out by dagre, not draggable. Pan/zoom per project is remembered in memory; the view re-fits when the node count changes. `colorMode="system"`.
- Merge selection lives in a small external store (`features/merge/selection.ts`) so it survives opening a chat. Its actions read the store's current value, never a render-time copy.
- The merge dialog sends the first message with the merge request; the server starts it, and the merged node's chat page attaches.
- React runs effects twice in development: guard effects that trigger paid model calls with a ref (see `ResultDialog`).
- Math: `Markdown` uses remark-math + rehype-katex. `lib/math.ts` `prepareMath` (tested) first converts `\(…\)`/`\[…\]`, escapes `$` that can't be inline math (Pandoc's rule, so "$5 and $10" stays text), puts a one-line `$$…$$` on its own lines so it displays, and leaves code alone. The system prompt asks for `$…$`/`$$…$$`, escaped prices, and LaTeX source in ```` ```latex ```` blocks.
- Dark mode: `lib/theme.ts` toggles the `dark` class from the OS setting. Status colors are Tailwind tokens: `open`, `done`, `merge`, `frozen` (+ `-soft`), `canvas`, `edge`.
- The browser-pane preview (`.claude/launch.json`) runs on its own ports (web 5180, server 8790 via `HARNESS_WEB_PORT` / `HARNESS_SERVER_PORT`) next to the user's dev server, with `HARNESS_DATA_DIR=data/preview` and the placeholder provider slowed down (`HARNESS_PLACEHOLDER_DELAY_MS=120`, ~6–8 s replies) so long-reply states can be tested. Testing never touches the real data, uploads, or model credit. (Variables set by the launcher win over `.env`.) When the pane isn't drawing, read cards with `textContent`, not `innerText`.

## Commands (run from the repo root)
- `npm run dev`: starts the server (http://localhost:8787) and the web UI (http://localhost:5173, which proxies `/api` to the server)
- `npm run typecheck`, `npm test` (server and web Vitest), `npm run lint`
- On Windows, Vite's file watcher sometimes misses an edit (the preview keeps serving the old module): `touch` the file.
- Add a dependency to one app: `npm install <pkg> -w @harness/web` (or `@harness/server`)
- Add a shadcn component: `npx shadcn@latest add <name>` from `apps/web`. Generated files in `src/components/ui` are not linted. Base UI buttons rendered as links need `nativeButton={false}`.
- Server env: `.env` at the repo root (see `.env.example`). The server port variable is `HARNESS_SERVER_PORT`, not `PORT`.

## Project structure
npm workspaces monorepo, started from Vite's `react-ts` template + shadcn/ui. Requires Node 24 LTS.
- `apps/web`: React UI. `src/app` (router, AppShell with the projects sidebar), `src/features/*` (projects, graph, chat, fork, result, merge, rename; later settings), `src/components/ui` (shadcn), `src/api` (typed server client).
- `apps/server`: Hono backend. `routes/` (projects: graph, merge; nodes: detail, rename, chat stream, fork, draft/approve result), `dag/` (core context-assembly logic: pure functions, heavily tested with Vitest), `llm/` (provider interface, Anthropic adapter, placeholder), `tools/` (MCP, later), `db/` (`node:sqlite`, migrations via `PRAGMA user_version`, `Repository`). `createApp({ repo, llm })` takes its dependencies so tests use `:memory:` and a fake provider.
- `apps/desktop`: Electron (later).
- `packages/shared`: types/schemas shared by web and server.
- `data/`: local SQLite file (gitignored).
- Routes: `/` (opens the last project), `/projects/:id` (graph), `/projects/:id/nodes/:nodeId` (full-window chat), `/settings` (later).

## Roadmap
1. MVP (done 2026-10-01): one project, graph view, full-window chat with real streaming (Claude through the provider interface), fork / finish / merge, SQLite persistence. API key from `.env`.
2. MCP tools in all branches (explicitly deferred out of the MVP), more providers.
3. Wrap in Electron.
4. Later ideas: autonomous (subagent) branches the user can step into, merge templates (synthesize / compare / pick best), a per-node context-budget display.

## Protecting the user's research (since 2026-10-02 the user does real research in this app)
- `data/harness.db` holds real work. Never delete it, `data/projects/`, or `data/backups/`.
- Backups (`apps/server/src/db/backup.ts`, consistent copies via `VACUUM INTO`, in `data/backups/`): before every migration (`before-migration-vN`, kept forever), before "Start over" (`before-reset`, kept forever; if the backup fails, nothing is deleted), once a day at startup (`daily`, newest 14 kept), and `manual` ones.
- Migrations must never delete or rewrite the user's messages, results or nodes. Append-only, as before.
- Before any risky change to real data (manual SQL, data fixes, schema experiments), make a manual backup first.
- Testing never uses the real data: the browser preview uses `data/preview/`, scripts use a scratch `HARNESS_DATA_DIR`.
- Not covered by these backups: uploaded files in `.harness/uploads/` (copies of the user's own files) and Claude Code's session files under `~/.claude/` (losing them only means a transcript replay). Backups are on the same disk.

## Improvements backlog
`IMPROVEMENTS.md` collects improvements the user wants later (documented, not implemented). Add new ideas there when the user asks to note them; implement only when asked.

## Working with the user
The user is fluent in Python, not a web developer (last web work was the jQuery era). Explain web/TS/React concepts when introducing them, and relate them to Python where helpful.
