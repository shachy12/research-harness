# Improvements backlog

Ideas collected while using the harness. Not implemented yet; each entry notes what's needed so we can pick it up later.

## 3. Stream the result draft live when finishing a branch
When closing a branch (Finish branch), the result summary should be written live, like chat replies. Currently it shows "Drafting the result…" until the whole draft arrives, which can take a while on Opus.
- Show the model writing the draft as it goes, like replies in the chat, then turn it into the editable form when done.
- **Claude Code:** the draft is a one-shot `--json-schema` run; switch it to `--output-format stream-json --include-partial-messages` and stream the text (the structured result arrives at the end).
- **API provider:** stream with the SDK instead of `messages.parse`, then parse the final JSON.
- **Server/UI:** the draft endpoint streams server-sent events (like chat replies); `ResultDialog` shows the text live, with the activity line and timer, then fills the fields.
- Partial JSON isn't pleasant to read: consider streaming a readable Markdown draft first and extracting the fields at the end, or showing the fields filling in as the JSON arrives.

## 4. Cross-project connections (multiple projects now exist, so this can be built)
The user works on two papers that sometimes connect. A finished node's result in one project should be usable in another, as an extra standalone ("orphan") node there.
- **Model:** import creates a node in the target project with no parents, already *finished*, holding a copy of the source result, plus a reference to where it came from (source project and node). In the target it behaves like any finished branch: it can be selected and merged with that project's branches.
- **Copy, not live link:** the result is copied at import time, so later edits in the source don't silently change the target. Offer "update from source" when the source result has changed.
- **Merge base:** an imported node has no ancestors in the target project, so the lowest-common-ancestor rule would find no base. Compute the base from the target project's own branches and ignore imported nodes, so the merged node keeps its project's context and adds the imported result.
- **Files:** Claude can only read inside the target project's folder, so an import carries the result text only. Optionally copy the source branch's attachments into the target's `.harness/uploads/`.
- **GUI:** an "Import result from another project…" action (or a cross-project picker); imported nodes get a distinct badge and show the source project name, linking to the source node.

## 5. Let the agent fork (via an MCP tool)
When a reply lists several directions ("1. … 2. … 3. …"), the user wants to say "fork for each of these" and have the agent create the branches, instead of typing them into the fork dialog.
- **Mechanism:** the harness exposes its own MCP server with a tool like `fork_branches({ branches: [{ prompt }] })` (later maybe `list_branches`, `read_result`, and `ask_node` from item 13). The agent calls it from inside a node; the harness forks *that* node.
  - **Claude Code:** pass the server with `--mcp-config` (keep `--strict-mcp-config` so the user's own MCP servers stay out) and pre-approve only `mcp__harness__fork_branches`. Simplest transport: an HTTP MCP endpoint on our Hono server (`/mcp`), with the node id in the URL or a header so the tool knows which node is calling.
  - **API provider:** the same tool as a regular custom tool in the request, handled by our server in the reply loop.
- **Timing:** the tool is called while the parent's reply is still running, but a fork freezes the parent and the branches should inherit the *whole* reply (including the list). So the call records the requested branches, and the harness creates and starts them right after the parent's reply finishes. The tool result tells the agent "N branches will start when this reply ends".
- **Confirmation (recommended default):** show the agent's proposed branches in the fork dialog, pre-filled, for the user to edit, add files to (see item 2) or confirm, instead of starting them silently. A setting could allow auto-start later.
- **Done (the no-MCP part):** see "Fork from list items and table rows" in CLAUDE.md; it was built as picking list items and table rows in replies instead of a "Fork from this list" button. What is left of this item is the MCP tool above.

## 8. Change model and effort while working (with a cache warning)
Choose the model (e.g. Opus 5.5 / Sonnet 5.5 / Haiku 4.5) and effort (low → max) per node while working, not only in `.env`.
- **GUI:** a model and effort picker by the composer and in the fork dialog (per branch). Branches inherit their parent's setting; a project default replaces `HARNESS_MODEL` / `HARNESS_EFFORT`.
- **Cache warning (correct, verified):** prompt caches are per model. The first reply after switching a node's model re-reads its whole inherited history without the cache; same for a branch forked onto a different model than its parent. Show it before switching, with the size: "Switching to Sonnet re-reads ~43K tokens of history at full price once (about N× a normal reply); later replies use the cache again."
- **Effort:** on the API, changing top-level effort mid-conversation also invalidates the cached conversation; Opus 5.5 / Sonnet 5.5 / Fable 5.1 support a per-message effort change that keeps the cache (beta `mid-conversation-output-config-2026-07-01`). Use that on the API provider. For Claude Code, pass `--effort` / `--model` when (re)starting the node's process; verify with the real CLI whether changing them on `--resume` keeps the cache, and warn accordingly.
- **Storage:** `model` and `effort` per node (append-only migration). Changing them restarts the node's Claude Code process with the new flags (session kept).
- **Side note:** each model's reasoning traces are tied to that model; after a switch, earlier turns' hidden reasoning isn't reused (the visible conversation is). Nothing to show the user, but expect the first reply after a switch to rethink from the transcript.

## 11. Shell and file-editing tools (discuss before implementing)
Add a shell tool (Bash on macOS/Linux, PowerShell or Git Bash on Windows) and Write/Edit, e.g. to compile LaTeX, run scripts and edit the paper. Branches run in parallel in the same project folder, so writes can collide. **Design to be agreed with the user first.**
- **Claude Code already has the tools** (`Bash`/`PowerShell`, `Write`, `Edit`); enabling them is a flag change (`--tools`). The real work is permissions and collisions. API provider: we would implement them as custom tools ourselves.
- **Collisions, options:**
  - **(a) Per-branch work folder (recommended starting point):** each node that writes gets `.harness/work/<nodeId>/`; Write/Edit are allowed only there via permission rules (`Edit(<path>/**)`), Read stays allowed in the whole project. The cwd stays the project folder, so Claude Code sessions still resume/fork (sessions are per folder). Outputs are listed in the result and passed along on merge; "Apply to project" copies chosen files into the real folder (user action, with a diff).
  - **(b) Git worktree per branch** when the project folder is a git repo (e.g. the LaTeX repo): the work folder from (a) is a `git worktree` on its own branch. Fork = branch from the parent's commit (the parent freezes, matching the DAG); merge = `git merge` of the branches, conflicts shown in the merge dialog; "Apply" = merge into the user's branch. Strong fit for the DAG, more machinery. Non-git folders fall back to (a) with plain copies.
  - **(c) Shared folder + per-file locks / conflict check** (fail a write if the file changed since the branch read it). Simple, but doesn't prevent branches stepping on each other's half-done work.
  - **(d) One writing branch at a time** per project (a write lock). Simplest, loses parallelism.
- **Shell is the hard part:** permission rules can't stop a shell command from writing outside the work folder. Options: Claude Code's sandbox (`--settings` with `sandbox` config: filesystem writes limited to given folders, network off or allow-listed; macOS Seatbelt / Linux bubblewrap; check native Windows support), an allow-list of commands (`latexmk`, `python`, …), or asking the user per command.
- **Approval in the GUI:** `-p` mode refuses anything not pre-approved. `--permission-prompt-tool mcp__harness__approve` (our MCP server, see item 5) lets the harness show "Branch X wants to run `latexmk main.tex` — Allow once / Always for this project / Deny" in the app instead of failing.
- **Safety for real data:** never let tools write to `data/` or outside the project; prefer that the project folder be a git repo when writing is on, so everything is undoable.
- **Open questions:** which option for collisions; should writes reach the real folder automatically or always via "Apply"; which shell commands need no approval; network access from the shell.

## 12. macOS and Linux support
The code is mostly portable already (Node, `node:sqlite`, paths via `node:path`, uploads split on both `\` and `/`). What's left:
- **Finding `claude`:** `findClaudeExecutable` only knows the Windows npm location, else `claude` on PATH. Add the native installer location (`~/.local/bin/claude`), npm global (`npm prefix -g`/bin), Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`). An Electron app started from Finder/a desktop launcher doesn't get the shell's PATH, so check these explicitly (or read the login shell's PATH once). Show a clear "Claude Code not found — install it or set its path" message in the GUI.
- **Tests:** some tests use Windows paths (`C:\…`, `D:\Research`) that mean something else on POSIX (e.g. `workspace.test.ts`); make them platform-neutral or per platform. Add a CI matrix (GitHub Actions: windows, macos, ubuntu) running typecheck, lint and tests.
- **Shell tool (item 11):** Bash on macOS/Linux, PowerShell/Git Bash on Windows; the system prompt should tell the model which OS and shell it has.
- **Case-sensitive file systems (Linux):** unique upload names and path checks must not assume case-insensitivity (`Paper.pdf` vs `paper.pdf`).
- **Electron packaging (roadmap step 3):** electron-builder targets `dmg` (+ code signing and notarization for macOS, needs an Apple Developer account), `AppImage`/`deb` for Linux, NSIS for Windows. Check `node:sqlite` in Electron's Node on each.
- **Folder dialog:** "Browse…" in the new-project dialog uses `osascript` on macOS and zenity/kdialog on Linux (`system/folder-picker.ts`); untested there.
- **Data folder:** use the OS's app-data location in the packaged app (`app.getPath('userData')`: `~/Library/Application Support/…`, `~/.config/…`, `%APPDATA%\…`) instead of the repo's `data/`; the dev setup keeps `data/`.

## 13. Keep the in-between context in cross-level merges
A merged node starts from the merge base (the lowest common ancestor) plus the merged branches' results (see "What a merged node starts from" in CLAUDE.md). When the merged branches sit at different depths, the conversation of the nodes between the base and a branch is dropped. Example: `Root → {A → {A1, A2}, B}`; merging A1 + B uses base Root, so A's own messages are not in the merged node, only A1's result (written with A in view).
- **Chosen direction: keep the merge as it is, and let the model ask the skipped nodes.** The merged node still starts from the base + the results (the nested trick stays, so prompts stay small and the base's cache is reused). Its merge message also lists the nodes on the way from the base to each merged branch, with their ids and titles, e.g. "A1's result was written in the context of node A (`<id>`, "Survey of ISD attacks"); ask it with `ask_node` if you need its details." The model can then fetch more context only when it needs it.
- **Mechanism:** a tool on the harness MCP server from item 5, e.g. `ask_node({ nodeId, question })`, answering from that node's full context.
  - **Claude Code:** answer with a one-shot run on a fork of that node's session (`--resume <node session> --fork-session --no-session-persistence`, like result drafts), so the node itself is never changed and its cache is reused. With no session, replay its context as a transcript (as `planSession` does).
  - **API provider:** the same tool as a custom tool; the server builds that node's prompt (`buildChatRequest`) and asks the question.
  - Maybe also `read_node({ nodeId })`, returning the node's result or transcript as text without a model call (cheaper, but long).
- **Node ids, not session ids, in the prompt:** the harness maps a node id to its session. Session ids belong to Claude Code, can be cleared (migration 4 did), and don't exist for the API provider. The tool only accepts nodes of the same project that are ancestors of (or merged into) the asking node, so the model can't wander into unrelated branches.
- **GUI:** show `ask_node` calls as tool rows in the chat ("Asked A: …"), with the answer collapsible, like web searches.
- **Not chosen (for now):** pasting summaries of the intermediate nodes into the merge up front. That costs a model call per node at every merge even when unused, and frozen nodes have no result to reuse.
- **Depends on** item 5's harness MCP server (`--mcp-config` + `--strict-mcp-config`, pre-approve only the harness tools).

## 13. Supported Claude Code versions, and telling the user when theirs isn't
The Claude Code provider depends on details a CLI update can change without notice: flags (`--input-format stream-json`, `--include-partial-messages`, `--fork-session`, `--json-schema`, `--system-prompt`, `--setting-sources ''`, `--strict-mcp-config`, `--tools`), the stream-json event shapes (`system:init` with `session_id`, `stream_event` deltas, `tool_use`/`tool_result`, `rate_limit_event`, `result` with `structured_output`), and the text format of WebSearch results (`Links: [...]`). Today a breaking update would show up as odd failures mid-research.
- **Define the range:** one constant in `llm/claude-code.ts`, e.g. `{ minimum: '2.1.287', testedUpTo: '2.1.287' }`.
  - Below `minimum`: **unsupported**. Don't start replies; say "Claude Code 2.0.x is too old for Harness; update it (`npm install -g @anthropic-ai/claude-code`, then run `node install.cjs` in the package folder on Windows)".
  - Between: fine.
  - Above `testedUpTo`: **untested**. Keep working, but show a quiet notice ("Claude Code 2.2.0 is newer than Harness was tested with; tell Claude if something breaks").
- **Detect the version:** run `claude --version` at server start and again when a node's process starts, cached for an hour (the CLI can update itself while the server runs). Also check whether the `system:init` event reports the version (not seen in 2.1.287's strings); if it does, compare on every run for free.
- **Check the flags, not just the number (free, no credit):** parse `claude --help` once per version and confirm every flag we pass exists. A missing flag means unsupported, whatever the number says.
- **Catch breakage at runtime:** treat "unknown option"/"unexpected argument" errors, an `init` without `session_id`, or a result draft without `structured_output` as a new error kind `version` ("Claude Code changed in a way Harness doesn't handle yet (version X)"), not a generic failure.
- **Where the user sees it:** the header's model chip shows the version ("claude-code 2.1.287"), with a warning style when untested or unsupported. A banner like the usage one on the graph and in chats explains it. `/api/health` returns `{ version, support: 'ok' | 'untested' | 'unsupported' }`.
- **Option: pin a version.** Install Claude Code as an exact-version dependency of the server instead of using the global install, so updates happen only when we bump it (`findClaudeExecutable` prefers the local copy). Setting `DISABLE_AUTOUPDATER=1` (the CLI knows this variable) for our runs avoids self-updates mid-run. npm 12 blocks the package's install script, so the setup must run `install.cjs` itself.
- **Raising `testedUpTo`:** an opt-in live check (`npm run check:claude`) that runs the real CLI once per feature (stream a short reply, fork a session, a result draft with `--json-schema`, a web search) for a few cents of credit, then compares the events with what `fake-claude.mjs` sends. Save the real output as fixtures per version, so the fake CLI stays faithful.
- **API provider too, briefly:** the SDK is pinned by `package-lock.json`, but model ids and beta headers (`server-side-fallback-2026-07-01`, the web tool versions) get retired. Classify "unknown beta"/"model not found" errors with a message that names what to update.

## Done
Implemented on 2026-10-02 (see CLAUDE.md for how they work). Leftovers worth doing later:
- **1. LaTeX support:** done (KaTeX rendering, delimiter safety net, prompt section). Left: syntax highlighting for code blocks, Mermaid diagrams; check whether resumed Claude Code sessions pick up the new system prompt.
- **2. Files per branch when forking:** done.
- **6. Rename and model-written titles:** done (pencil on cards and in the chat header, Suggest button, automatic title after the first reply, `title_source`).
- **7. Remember what was read in each node:** done (`read_upto` per node, opening position, "N new" badge on cards, follow-the-stream only at the bottom). Left: an unread marker line inside the chat at the first unread reply; marking read for results of finished branches.
- **5 (part). Fork from list items and table rows:** done, without MCP (click list items or table rows in a reply, one instruction for all, one branch per pick; titles from the items; table rows carry their column names). Left: the agent-called `fork_branches` tool (the rest of item 5). Possible extras: pick whole paragraphs, keyboard picking, keep the selection when leaving the chat, a "select all rows/items" shortcut.
- **9. Clear "limit reached" message:** done (classified errors, banner with reset time and share used, e.g. "25% of your weekly limit used", Retry and Retry all). Left: capture a real limit hit to confirm the event shapes (and the monthly `-p` credit wording); retry automatically when the limit resets.
- **10. One attach button:** done (paperclip with a Files/Folder menu).
- **Multiple projects** (asked for directly, not a backlog item): done (sidebar, new project with an optional working folder picked in the OS folder dialog, rename, reopens the last project). Left: deleting a project (on purpose not built; it should back up first, like "Start over"); try the folder dialog on macOS and Linux (see item 12).
