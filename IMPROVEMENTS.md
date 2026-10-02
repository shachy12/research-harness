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

## 6. Rename nodes, and model-written titles
Titles taken from the first line of a prompt are often long and awkward ("Let understand the feasibility of this linear cube root rc-pir, we should start…").
- **Manual rename (always wins):** click the title in the chat header to edit it; a "Rename" action on graph cards. The API already exists (`PATCH /nodes/:id`, `useRename` in `api/queries.ts`); only the UI is missing.
- **Automatic title:** once, right after a node's first reply, ask a small fast model for a 3–7 word title ("Linear-storage cube-root RC-PIR feasibility"). Claude Code: a throwaway `claude -p --model haiku --no-session-persistence` run given the prompt and the start of the reply; API provider: one small request. Costs a fraction of a cent and doesn't touch the node's conversation.
- **Never overwrite the user:** store where a title came from (`title_source`: `prompt` | `model` | `user`). The model only replaces `prompt` titles; a user rename sets `user` and is final. Optional "Suggest a title" button to re-run it on demand.
- Merge nodes: the same, based on the merge's first message.

## 7. Remember what was read in each node
Opening a node always jumps to the bottom. Each node should remember which assistant replies the user has read.
- **Opening a node:** never opened → start at the top; opened before with unread replies → scroll to the start of the first unread reply; everything read → the end.
- **Marking read:** a reply counts as read once its end has been on screen (an IntersectionObserver on a marker after each reply; short replies that fit count when seen). Monotonic: only moves forward.
- **Storage:** server-side so it survives restarts and works in Electron later: a `read_upto` message id per node (append-only migration; the automatic pre-migration backup covers it), plus a small `PUT /nodes/:id/read` endpoint.
- **Don't yank the view:** while a reply streams, follow it only if the user is already at the bottom; after sending a message, jump to the bottom.
- **Graph:** an unread badge on cards ("2 new"), most useful after a fork when several branches finish while the user is elsewhere.

## 8. Change model and effort while working (with a cache warning)
Choose the model (e.g. Opus 5.5 / Sonnet 5.5 / Haiku 4.5) and effort (low → max) per node while working, not only in `.env`.
- **GUI:** a model and effort picker by the composer and in the fork dialog (per branch). Branches inherit their parent's setting; a project default replaces `HARNESS_MODEL` / `HARNESS_EFFORT`.
- **Cache warning (correct, verified):** prompt caches are per model. The first reply after switching a node's model re-reads its whole inherited history without the cache; same for a branch forked onto a different model than its parent. Show it before switching, with the size: "Switching to Sonnet re-reads ~43K tokens of history at full price once (about N× a normal reply); later replies use the cache again."
- **Effort:** on the API, changing top-level effort mid-conversation also invalidates the cached conversation; Opus 5.5 / Sonnet 5.5 / Fable 5.1 support a per-message effort change that keeps the cache (beta `mid-conversation-output-config-2026-07-01`). Use that on the API provider. For Claude Code, pass `--effort` / `--model` when (re)starting the node's process; verify with the real CLI whether changing them on `--resume` keeps the cache, and warn accordingly.
- **Storage:** `model` and `effort` per node (append-only migration). Changing them restarts the node's Claude Code process with the new flags (session kept).
- **Side note:** each model's reasoning traces are tied to that model; after a switch, earlier turns' hidden reasoning isn't reused (the visible conversation is). Nothing to show the user, but expect the first reply after a switch to rethink from the transcript.

## 9. Say clearly when the Claude Code limit is reached
When the subscription limit runs out, the reply currently ends with "Claude Code stopped unexpectedly (exit code 1)" or the CLI's raw error text. The user should see what happened and when it comes back.
- **Detect it from the stream, not the exit code:** the CLI emits `rate_limit_event` lines (`rate_limit_info: { status: allowed | allowed_warning | rejected, resetsAt, rateLimitType: five_hour | seven_day, isUsingOverage }`), and a failed turn's `result` has `is_error: true` with text like "You've hit your limit · resets …" / "usage limit reached". Assistant messages can also carry `error: "rate_limit"` (others: `billing_error`, `authentication_failed`). Seen in the installed CLI (2.1.287); capture a real limit hit (stdout lines) once to confirm the exact shape, and add it to `fake-claude.mjs` for tests.
- **Error kinds:** classify into `usage_limit` (with reset time and which limit), `auth` (logged out → "run `claude` once in a terminal to sign in"), `billing`, and `other` (keep the current message + last stderr line). Same classification for the one-shot result-draft run.
- **Monthly `-p` credit:** background runs use a separate monthly credit (see CLAUDE.md, Providers). Check what message the CLI gives when that one runs out and word it separately ("monthly Claude Code credit used up, resets on …").
- **GUI:** a distinct banner on the reply instead of the generic error: "Claude usage limit reached — resets at 17:00 (in 2 h 10 min)", with Retry. Keep the partial reply as now. On the graph, nodes that failed this way show "Limit reached" instead of "! No reply".
- **Warnings before it happens:** on `allowed_warning`, show a small note ("Close to your 5-hour limit") in the chat header, so the user can avoid starting a big fork of many parallel branches right then.
- **Parallel branches:** when one reply hits the limit, the others will too. Don't let every running branch fail separately; say it once at the project level and offer "Retry all when it resets".

## 10. One attach button for files and folders
The composer has two buttons (paperclip for files, folder for folders).
- **Browser limit:** a web page can't open one dialog that picks both: `<input type="file">` picks files, and with `webkitdirectory` picks one folder only. The newer `showOpenFilePicker` / `showDirectoryPicker` APIs are also separate.
- **Web UI now:** one paperclip button that opens a small menu: "Files…" / "Folder…" (plus the hint "or drop files and folders here"; drop already accepts both at once).
- **Electron later:** the native dialog (`dialog.showOpenDialog` with `openFile` + `openDirectory` + `multiSelections`) picks both in one dialog on macOS; on Windows and Linux Electron then shows a folder-only picker, so keep the menu there. Electron also gives real paths, so files already inside the project folder could be referenced without copying.

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
- **Data folder:** use the OS's app-data location in the packaged app (`app.getPath('userData')`: `~/Library/Application Support/…`, `~/.config/…`, `%APPDATA%\…`) instead of the repo's `data/`; the dev setup keeps `data/`.
