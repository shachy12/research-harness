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

## Model settings
- Default model `claude-opus-5-5`, effort `high` (Opus 5.5's own default is `medium`, so it is set explicitly). Override with `HARNESS_MODEL` / `HARNESS_EFFORT`.
- Requests use the server-side refusal fallback (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`).
- Thinking is always on for Opus 5.5 and its text is not shown; the chat stream sends a `thinking` event so the UI can show a "Thinking…" state.
- Without `ANTHROPIC_API_KEY`, the server uses `PlaceholderProvider`, which streams an explanation instead of failing.

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
- Fork: a dialog to name the sub-questions, then return to the graph to show the new branches.
- Finish: the LLM drafts the result (Findings / Evidence & sources / Open questions / Confidence); the user edits and approves it.
- Merge: right-click finished nodes in the graph to toggle them for merge (the card shows a "Selected for merge" badge; right-clicking an unfinished node shakes it and shows a hint), then "Merge selected" opens a preview (base context + results, tokens saved compared with full transcripts, title, framing prompt), then opens the new merged node.
- Edges: solid = inherits full context; dashed with a "result" label = merge edge that passes only the result.
- Considered and dropped: a split view (graph + side chat), and a canvas where every node is an inline chat.

### Web implementation notes
- Server data goes through TanStack Query hooks in `apps/web/src/api/queries.ts`; after any change `useRefreshAll()` refetches the graph and node details.
- Chat streaming: `streamChat()` in `api/client.ts` reads the server-sent events; `features/chat/useChatStream.ts` holds the live state. Leaving the page does not stop a reply (the server finishes and saves it); the Stop button aborts.
- Graph: React Flow with fixed-size cards (`CARD_WIDTH`/`CARD_HEIGHT`) laid out by dagre, not draggable. Pan/zoom per project is remembered in memory; the view re-fits when the node count changes. `colorMode="system"`.
- Merge selection lives in a small external store (`features/merge/selection.ts`) so it survives opening a chat. Its actions read the store's current value, never a render-time copy.
- The merge dialog navigates to the new node with `state.autoSend` (the first message); the chat sends it once.
- React runs effects twice in development: guard effects that trigger paid model calls with a ref (see `ResultDialog`).
- Dark mode: `lib/theme.ts` toggles the `dark` class from the OS setting. Status colors are Tailwind tokens: `open`, `done`, `merge`, `frozen` (+ `-soft`), `canvas`, `edge`.
- The browser-pane preview (`.claude/launch.json`) uses `data/preview.db`, so testing never touches the real `data/harness.db`.

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
