# Improvements backlog

Ideas collected while using the harness. Not implemented yet; each entry notes what's needed so we can pick it up later.

## 1. LaTeX support (prompt + GUI)
Math in replies (`$x^2$`, `$$\sum_i …$$`) currently shows as raw text.
- **GUI:** render math with `remark-math` + KaTeX in `apps/web/src/features/chat/Markdown.tsx`. Before rendering, convert `\(…\)` → `$…$` and `\[…\]` → `$$…$$` as a safety net (Claude sometimes uses those).
- **Prompt:** add a formatting section to `SYSTEM_PROMPT` (`apps/server/src/dag/prompt.ts`): Markdown replies, tables for comparisons, `$…$` / `$$…$$` for math (not `\(…\)` / `\[…\]`), LaTeX *source* (document fragments, macros to copy) in ```` ```latex ```` code blocks so it is never rendered as math.
- **Check:** Claude Code records the system prompt per session (`--system-prompt-snapshot`), so resumed/forked older sessions may keep the old prompt. Verify with the real CLI; the renderer's delimiter conversion covers them either way.
- **Optional extras:** syntax highlighting for code blocks (including `latex`); Mermaid diagrams.
- Rendering is client-side, so existing messages benefit too.

## 2. Attach files to each branch when forking
The fork dialog has one text field per branch; it should also take files/folders per branch, sent with that branch's first message.
- **GUI:** per-branch attach button and drop zone in `ForkDialog` (reuse `useAttachments` and `AttachmentChip`); "Start" waits for uploads.
- **API:** `forkSchema` gets `branches: { prompt, attachments }[]` (or `attachments` alongside `prompts`); the fork route validates them with `Workspaces.validate` and passes them to `runs.start(child, prompt, attachments)`, which already supports attachments.

## 3. Stream the result draft live when finishing a branch
When closing a branch (Finish branch), the result summary should be written live, like chat replies. Currently it shows "Drafting the result…" until the whole draft arrives, which can take a while on Opus.
- Show the model writing the draft as it goes, like replies in the chat, then turn it into the editable form when done.
- **Claude Code:** the draft is a one-shot `--json-schema` run; switch it to `--output-format stream-json --include-partial-messages` and stream the text (the structured result arrives at the end).
- **API provider:** stream with the SDK instead of `messages.parse`, then parse the final JSON.
- **Server/UI:** the draft endpoint streams server-sent events (like chat replies); `ResultDialog` shows the text live, with the activity line and timer, then fills the fields.
- Partial JSON isn't pleasant to read: consider streaming a readable Markdown draft first and extracting the fields at the end, or showing the fields filling in as the JSON arrives.

## 4. Cross-project connections (needs multiple projects first)
The user works on two papers that sometimes connect. A finished node's result in one project should be usable in another, as an extra standalone ("orphan") node there.
- **Model:** import creates a node in the target project with no parents, already *finished*, holding a copy of the source result, plus a reference to where it came from (source project and node). In the target it behaves like any finished branch: it can be selected and merged with that project's branches.
- **Copy, not live link:** the result is copied at import time, so later edits in the source don't silently change the target. Offer "update from source" when the source result has changed.
- **Merge base:** an imported node has no ancestors in the target project, so the lowest-common-ancestor rule would find no base. Compute the base from the target project's own branches and ignore imported nodes, so the merged node keeps its project's context and adds the imported result.
- **Files:** Claude can only read inside the target project's folder, so an import carries the result text only. Optionally copy the source branch's attachments into the target's `.harness/uploads/`.
- **GUI:** an "Import result from another project…" action (or a cross-project picker); imported nodes get a distinct badge and show the source project name, linking to the source node.

## 5. Let the agent fork (via an MCP tool)
When a reply lists several directions ("1. … 2. … 3. …"), the user wants to say "fork for each of these" and have the agent create the branches, instead of typing them into the fork dialog.
- **Mechanism:** the harness exposes its own MCP server with a tool like `fork_branches({ branches: [{ prompt }] })` (later maybe `list_branches`, `read_result`). The agent calls it from inside a node; the harness forks *that* node.
  - **Claude Code:** pass the server with `--mcp-config` (keep `--strict-mcp-config` so the user's own MCP servers stay out) and pre-approve only `mcp__harness__fork_branches`. Simplest transport: an HTTP MCP endpoint on our Hono server (`/mcp`), with the node id in the URL or a header so the tool knows which node is calling.
  - **API provider:** the same tool as a regular custom tool in the request, handled by our server in the reply loop.
- **Timing:** the tool is called while the parent's reply is still running, but a fork freezes the parent and the branches should inherit the *whole* reply (including the list). So the call records the requested branches, and the harness creates and starts them right after the parent's reply finishes. The tool result tells the agent "N branches will start when this reply ends".
- **Confirmation (recommended default):** show the agent's proposed branches in the fork dialog, pre-filled, for the user to edit, add files to (see item 2) or confirm, instead of starting them silently. A setting could allow auto-start later.
- **Simpler first step (no MCP), the user likes this one:** a "Fork from this list" button on a reply that has a list, which opens the fork dialog pre-filled with one branch per list item. Covers most of the need and also works for replies that already exist.
  - **Instruction for each item:** one field says what every branch should do with its item ("Explain each of these", "Check whether we can … for this one"). Each branch's first message = instruction + its item; `{item}` in the instruction places the item explicitly ("Compare {item} with our construction from §3").
  - **Titles come from the items** (not the shared instruction), so branches stay distinguishable on the graph.
  - **Review before starting:** a checkbox per item to skip some, each branch's resulting message editable, files per branch (item 2).
  - **List detection:** take numbered and bulleted top-level items from the reply's Markdown (a sub-list belongs to its parent item); if a reply has several lists, let the user pick which one.
  - The same instruction field fits the MCP version: "fork for each of these and check …" becomes the instruction the agent passes along.
