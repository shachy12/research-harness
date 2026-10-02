# Harness ג€” DAG-based LLM research chat

## Concept
A chat harness where a conversation is a DAG instead of a linear thread, matching a research workflow:

1. Start with a **root node** (a normal chat).
2. **Fork** a node into N child branches. Each child inherits the full context of its parent.
3. Work each branch as a short sub-research task.
4. **Finish** a branch ג†’ produce a **result** (a distilled report, not the transcript).
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
- **Vercel AI SDK ג†’ own provider interface + official SDKs.** Claude is called through the official Anthropic SDK (direct access to prompt caching, structured outputs, refusal fallbacks). Providers stay pluggable through `LLMProvider`.
- **Drizzle + better-sqlite3 ג†’ `node:sqlite`.** No native module to rebuild for Electron, and npm 12 blocks install scripts by default. Four tables and simple queries don't need an ORM. Verify `node:sqlite` is available in Electron's bundled Node when we get there; the repository module is the only place to change if not.

## Providers
Chosen with `HARNESS_PROVIDER` in `.env`: `claude-code` (the user's choice for their own research: runs on their Claude subscription), `anthropic` (API key, pay per token), or `placeholder`.

Why Claude Code: Anthropic's terms don't allow Claude.ai subscription logins in third-party apps (no "Sign in with Claude", no reusing OAuth tokens). Running the official Claude Code CLI on your own machine is allowed; background runs (`claude -p`) count against a separate monthly credit included with Pro/Max (since 2026-06-15). The API stays available as a provider.

### Claude Code provider (`apps/server/src/llm/claude-code.ts`)
- Each node gets one long-lived `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` process; user messages go to stdin as `{"type":"user","message":{"role":"user","content":...}}` lines, each turn ends with a `result` event. The process is stopped after 10 minutes idle, on Stop (abort), and when the node is forked or finished (`release`). The next message restarts it with `--resume`.
- A node's Claude Code session id is stored in `nodes.session_id` (from the `system:init` event). `dag/session.ts` `planSession` decides how a node's first message starts: `resume` its own session, `fork` the parent's (merge: the base's) session with `--resume X --fork-session`, or `new`. The branch note / merge results go in front of the first message. If there is no session to fork from (e.g. nodes made with another provider), the earlier context is sent as a rendered transcript.
- Tools: `--tools WebSearch,WebFetch,Read,Glob,Grep`, but only `--allowedTools WebSearch,WebFetch` are pre-approved. Read/Glob/Grep work inside the working folder by Claude Code's default permissions; a read outside it needs approval, which `-p` mode refuses (verified 2026-10-02: it shows up as a permission denial). So the model can read the project folder and nothing else. Our `SYSTEM_PROMPT` replaces Claude Code's default (`--system-prompt`); `--setting-sources ''` and `--strict-mcp-config` ignore the user's own Claude Code settings, memory and MCP servers.
- Runs happen in the project's working folder (`ReplyContext.workDir`). Claude Code keeps sessions per folder, so sessions only resume from the folder that created them; migration 4 cleared the older session ids (made in a shared folder), and `planSession`'s transcript fallback takes over for those nodes. If a project's folder ever changes, clear its nodes' session ids the same way.
- Result drafts: a one-shot run with `--resume <node session> --fork-session --no-session-persistence --output-format json --json-schema ג€¦`; the answer is in `structured_output`. The CLI rejects the `$schema` line zod adds to JSON Schemas, so it is stripped.
- Tool calls come from `assistant`/`tool_use` (WebSearch `input.query`, WebFetch `input.url`) and `user`/`tool_result` blocks; search result links are parsed from the `Links: [...]` JSON in the result text.
- Windows notes: the npm package's postinstall (which places `claude.exe`) is blocked by npm 12; run `node install.cjs` in the package folder once. `findClaudeExecutable` uses `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` directly (the `claude.ps1` shim is blocked by the PowerShell policy). Windows PowerShell drops empty-string arguments to native programs, so test the CLI from Node, not PowerShell.
- Tests use `llm/fake-claude.mjs`, a fake CLI speaking the same protocol.

## Model settings (anthropic provider)
- Default model `claude-opus-5-5`, effort `high` (Opus 5.5's own default is `medium`, so it is set explicitly). Override with `HARNESS_MODEL` / `HARNESS_EFFORT`.
- Requests use the server-side refusal fallback (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`).
- Thinking is always on for Opus 5.5 and its text is not shown; the chat stream sends a `thinking` event so the UI can show a "Thinkingג€¦" state.
- Without `ANTHROPIC_API_KEY`, the server uses `PlaceholderProvider`, which streams an explanation instead of failing. A message containing "search" makes it show a sample search, to test the tool display.
- Web research: every chat request includes Anthropic's server-side tools `web_search_20260209` and `web_fetch_20260209` (max 10 uses each per reply; they include dynamic filtering, so don't add a separate `code_execution` tool). `pause_turn` is resumed by sending the paused assistant content back unchanged (up to 5 times). Result drafts run without tools.
- Tool calls are stored per message (`messages.tool_calls`, JSON `ToolCall[]`: query or URL, status, result titles/URLs) and streamed as `tool` events. Raw search results are not kept in history; instead each assistant turn in later prompts ends with a `[Sources consulted for this reply: ג€¦]` list (`withSources` in `dag/prompt.ts`), so follow-ups and result drafts can cite them.

## Prompt construction (apps/server/src/dag)
- One fixed system prompt for every node. Node-specific framing goes into the conversation: a `[A new branch starts here: ג€¦]` user turn where a branch begins, and a `[Merge node ג€¦]` user turn carrying the branch results.
- Cache breakpoint on the last inherited turn (siblings share it) plus top-level automatic caching for the growing conversation.
- Merge base = lowest common ancestor of the merged branches. Merged branches contribute only `formatResult(...)` text.
| Frontend | React + Vite |
| Graph view | React Flow |
| UI components | shadcn/ui + Tailwind |
| Desktop | Electron + electron-builder (web UI first, then wrap in Electron) |

## GUI (decided)
Clickable mockup: `mockups/gui-mockup.html` (published at https://claude.ai/artifact/B2ZDmYmj6V8C8tnf7nGw13).

- **Main window = the graph.** Nodes are cards (status chip, title, last message or result summary, message count). Auto-laid out top to bottom; pan and zoom; Fit button.
- **Clicking a node opens its chat full-window**, replacing the graph (a view switch, not a dialog or side panel). The header has a "ג† Graph" button (and Esc) plus a breadcrumb of ancestors. Returning to the graph keeps the previous pan/zoom.
- Chat view: inherited context collapsed at the top (message count and token estimate), collapsible tool calls, the result block once finished, a composer, and Fork / Finish branch actions.
- Fork: a dialog where you write each branch's first message (starts with one field; + Add branch for more; forking an already-forked node again adds more children); the branch title is derived from it (`titleFromPrompt`, first line, ~80 chars). Creating the branches starts all of them working in parallel, then returns to the graph.
- Activity indicator on open nodes (graph cards and chat header): "Workingג€¦" while the model replies, "ג— Your turn" when waiting for you, "! No reply" if the last message is yours and nothing is running (failed or stopped early). Forked/finished nodes show their status instead. The graph refreshes every 1.5 s while any node is working.
- Finish: the LLM drafts the result (Findings / Evidence & sources / Open questions / Confidence); the user edits and approves it.
- Merge: right-click finished nodes in the graph to toggle them for merge (the card shows a "Selected for merge" badge; right-clicking an unfinished node shakes it and shows a hint), then "Merge selected" opens a preview (base context + results, tokens saved compared with full transcripts, title, framing prompt), then opens the new merged node.
- Edges: solid = inherits full context; dashed with a "result" label = merge edge that passes only the result.
- Considered and dropped: a split view (graph + side chat), and a canvas where every node is an inline chat.

### Project folders and attachments (`apps/server/src/workspace.ts`)
- Each project has a working folder: `projects.folder`, or by default `<data>/projects/<id>/` (the user will be able to choose it later, e.g. their LaTeX repo). Managed data lives in `<folder>/.harness/` (with a `.gitignore` of `*`); uploads go to `.harness/uploads/` under safe, unique names (`paper.pdf`, `paper-2.pdf`).
- `POST /projects/:id/uploads` (multipart field `file`, max 50 MB) returns an `Attachment { name, path, size }`. Messages carry `attachments`; the server only accepts existing files in that project's uploads folder (`Workspaces.validate`).
- Files are not inlined: `withAttachments` adds `[The user attached a file. Read it with the Read tool before answering: <absolute path>]` to the message (also in replayed history). Once read, the content is in the Claude Code session, so later forks inherit it without reading again (verified). The API provider has no Read tool, so attachments are Claude Code only for now.
- Folders: `POST /projects/:id/uploads/folder` (fields `name`, then `path` + `file` pairs) copies a folder with its structure to `.harness/uploads/<name>/` (unique name, every path part made safe, so nothing lands outside it). Limits: 2,000 files, 200 MB. Hidden entries (`.git`, ג€¦), `node_modules`, `__MACOSX` are skipped (`isSkippedUploadName`). A folder attachment has `kind: 'folder'` and `fileCount`; the message note tells Claude to list it with Glob and read the relevant files (verified with a real LaTeX project).
- Composer: paperclip button (files), folder button (`<input webkitdirectory>`, grouped by `groupPickedFolder`), or drop files and folders on the chat (`readDrop` walks the dropped folder tree via `webkitGetAsEntry`/`readEntries`; it must start during the drop event). Each item uploads immediately and shows as a chip ("thesis/ ֲ· 23 files ֲ· 1.2 MB"); Send waits for uploads. Sent messages show their attachments; file reads show as tool rows ("Read draft.tex", "Found files").
- `HARNESS_DATA_DIR` sets the data folder (database + default project folders); the browser-pane preview uses `data/preview/`.

### Replies run on the server (`apps/server/src/runs.ts`)
- `RunManager` runs one reply per node at a time, independent of any open page, and saves it when done (or what arrived, on failure/Stop). Fork and merge start their nodes' first messages through it.
- `POST /nodes/:id/messages` starts a reply and streams it (`user`, then live events). `GET /nodes/:id/stream` attaches to a running reply (`snapshot` of the reply so far, then live events; `idle` if nothing runs). `POST /nodes/:id/stop` stops it. Disconnecting only stops watching.
- `watchRun` subscribes synchronously when the request arrives (not inside the SSE callback), so a fast reply can't finish unseen.
- `NodeSummary.running` / `lastRole` and `NodeDetail.running` drive the activity indicators; the chat page attaches automatically when it opens a running node.

### Web implementation notes
- Server data goes through TanStack Query hooks in `apps/web/src/api/queries.ts`; after any change `useRefreshAll()` refetches the graph and node details.
- Chat streaming: `streamChat()` (send) and `watchChat()` (attach) in `api/client.ts` read the server-sent events; `features/chat/useChatStream.ts` holds the live state (`send`, `watch`, `stop`). Leaving the page only stops watching; Stop calls the server's stop endpoint.
- Graph: React Flow with fixed-size cards (`CARD_WIDTH`/`CARD_HEIGHT`) laid out by dagre, not draggable. Pan/zoom per project is remembered in memory; the view re-fits when the node count changes. `colorMode="system"`.
- Merge selection lives in a small external store (`features/merge/selection.ts`) so it survives opening a chat. Its actions read the store's current value, never a render-time copy.
- The merge dialog sends the first message with the merge request; the server starts it, and the merged node's chat page attaches.
- React runs effects twice in development: guard effects that trigger paid model calls with a ref (see `ResultDialog`).
- Dark mode: `lib/theme.ts` toggles the `dark` class from the OS setting. Status colors are Tailwind tokens: `open`, `done`, `merge`, `frozen` (+ `-soft`), `canvas`, `edge`.
- The browser-pane preview (`.claude/launch.json`) uses `HARNESS_DATA_DIR=data/preview` and the placeholder provider, so testing never touches the real data, uploads, or model credit. (Variables set by the launcher win over `.env`.)

## Commands (run from the repo root)
- `npm run dev`: starts the server (http://localhost:8787) and the web UI (http://localhost:5173, which proxies `/api` to the server)
- `npm run typecheck`, `npm test`, `npm run lint`
- Add a dependency to one app: `npm install <pkg> -w @harness/web` (or `@harness/server`)
- Add a shadcn component: `npx shadcn@latest add <name>` from `apps/web`. Generated files in `src/components/ui` are not linted. Base UI buttons rendered as links need `nativeButton={false}`.
- Server env: `.env` at the repo root (see `.env.example`). The server port variable is `HARNESS_SERVER_PORT`, not `PORT`.

## Project structure
npm workspaces monorepo, started from Vite's `react-ts` template + shadcn/ui. Requires Node 24 LTS.
- `apps/web`: React UI. `src/app` (router, AppShell with a sidebar slot), `src/features/*` (graph, chat, fork, result, merge; later projects, settings), `src/components/ui` (shadcn), `src/api` (typed server client).
- `apps/server`: Hono backend. `routes/` (projects: graph, merge; nodes: detail, rename, chat stream, fork, draft/approve result), `dag/` (core context-assembly logic: pure functions, heavily tested with Vitest), `llm/` (provider interface, Anthropic adapter, placeholder), `tools/` (MCP, later), `db/` (`node:sqlite`, migrations via `PRAGMA user_version`, `Repository`). `createApp({ repo, llm })` takes its dependencies so tests use `:memory:` and a fake provider.
- `apps/desktop`: Electron (later).
- `packages/shared`: types/schemas shared by web and server.
- `data/`: local SQLite file (gitignored).
- Routes: `/projects/:id` (graph), `/projects/:id/nodes/:nodeId` (full-window chat), `/settings` (later).

## Roadmap
1. MVP (done 2026-10-01): one project, graph view, full-window chat with real streaming (Claude through the provider interface), fork / finish / merge, SQLite persistence. API key from `.env`.
2. MCP tools in all branches (explicitly deferred out of the MVP), more providers.
3. Wrap in Electron.
4. Later ideas: autonomous (subagent) branches the user can step into, merge templates (synthesize / compare / pick best), a per-node context-budget display.

## Working with the user
The user is fluent in Python, not a web developer (last web work was the jQuery era). Explain web/TS/React concepts when introducing them, and relate them to Python where helpful.
