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
| Backend | Node with Hono or Fastify (local server first, later moved into the Electron main process) |
| LLM providers | Vercel AI SDK (provider abstraction, unified tool-calling loop, streaming, structured output) |
| Tools | MCP client; tools are MCP servers (any language, so Python tools are fine as MCP servers) |
| Storage | SQLite via Drizzle ORM + better-sqlite3 |
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

## Commands (run from the repo root)
- `npm run dev`: starts the server (http://localhost:8787) and the web UI (http://localhost:5173, which proxies `/api` to the server)
- `npm run typecheck`, `npm test`, `npm run lint`
- Add a dependency to one app: `npm install <pkg> -w @harness/web` (or `@harness/server`)
- Add a shadcn component: `npx shadcn@latest add <name>` from `apps/web`. Generated files in `src/components/ui` are not linted. Base UI buttons rendered as links need `nativeButton={false}`.
- Server env: `.env` at the repo root (see `.env.example`). The server port variable is `HARNESS_SERVER_PORT`, not `PORT`.

## Project structure (planned)
npm workspaces monorepo, started from Vite's `react-ts` template + shadcn/ui. Requires Node 24 LTS.
- `apps/web`: React UI. `src/app` (router, AppShell with a sidebar slot), `src/features/*` (graph, chat, fork, result, merge; later projects, settings), `src/components/ui` (shadcn), `src/api` (typed server client).
- `apps/server`: Hono backend. `routes/`, `dag/` (core context-assembly logic: pure functions, heavily tested with Vitest), `llm/` (provider registry on the Vercel AI SDK), `tools/` (MCP, later), `db/` (Drizzle + SQLite).
- `apps/desktop`: Electron (later).
- `packages/shared`: types/schemas shared by web and server.
- `data/`: local SQLite file (gitignored).
- Routes: `/projects/:id` (graph), `/projects/:id/nodes/:nodeId` (full-window chat), `/settings` (later).

## Roadmap
1. MVP: one project, graph view, full-window chat with real streaming (Claude through the provider registry), fork / finish / merge, SQLite persistence. API key from `.env`.
2. MCP tools in all branches (explicitly deferred out of the MVP), more providers.
3. Wrap in Electron.
4. Later ideas: autonomous (subagent) branches the user can step into, merge templates (synthesize / compare / pick best), a per-node context-budget display.

## Working with the user
The user is fluent in Python, not a web developer (last web work was the jQuery era). Explain web/TS/React concepts when introducing them, and relate them to Python where helpful.
