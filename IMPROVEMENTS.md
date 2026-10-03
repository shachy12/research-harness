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

## 5. Harness MCP tools: leftovers (fork_branches and ask_node are done)
Built 2026-10-03, see "Harness MCP server" in CLAUDE.md. Left:
- **API provider:** no harness tools there yet. Add `fork_branches` / `ask_node` as custom tools in the reply loop (handle `stop_reason: 'tool_use'`, run the tool on the server, send the `tool_result` back), and `askNode` (that node's `buildChatRequest` + the question). The merge note already mentions `ask_node` on both providers.
- **Auto-start proposals:** a setting to start proposed branches without the review step.
- **Dismiss a proposal:** the box stays under its reply while the node is open (a new reply without a proposal clears the graph chip, but the box stays). A "Dismiss" button would need a stored flag.
- **`read_node({ nodeId })`:** a node's result or transcript as text, without a model call (cheaper than `ask_node`, but long).
- **More tools on the same server:** permission approval for shell commands (item 11), `list_nodes` / `read_result` (read the project's finished results without a merge), a project bibliography (`add_source`, `.bib` export).
- **ask_node answers are not stored separately:** they live in the asking reply's tool call (`ToolCall.output`, first 20,000 chars). Later turns of the asking node don't see them unless the reply quoted them (raw tool results aren't kept in history, like web searches).

## 8. Model and effort: leftovers
Per-node model and effort is done (see "Done" below and "Model and effort per node" in CLAUDE.md). Left:
- **"Written by" under each reply:** e.g. "claude-sonnet-5-5" in small text under an assistant message. `messages.model` is already stored (the model the provider reported, so a refusal fallback shows up too); older replies have none. Maybe the effort too, which would need a `messages.effort` column (new migration).
- **Model on graph cards:** a small label (e.g. "sonnet · low") so mixed-model graphs are visible at a glance; only when it differs from the root's, to keep cards calm.
- **API provider: change effort without losing the cache.** Opus 5.5 / Sonnet 5.5 / Fable 5.1 accept a per-message effort change (beta `mid-conversation-output-config-2026-07-01`: an empty `role: "system"` message with `output_config: { effort }` before the next user turn). Needs the effort each turn was written with (`messages.effort`) so the history stays identical between requests; the top-level effort stays the conversation's first. Then the warning only appears for a model change. (Claude Code's own requests already send a per-turn-control beta, but a changed `--effort` still lost the cache in our measurements.)
- **Side note:** each model's hidden reasoning is tied to that model; after a switch the earlier turns' reasoning isn't reused (the visible conversation is). Nothing to show, but the first reply after a switch rethinks from the transcript.

## 11. Shell tool (file editing is done)
File editing with a git worktree per node is built (2026-10-03, see "File editing" in CLAUDE.md). Left:
- **Shell tool: done (2026-10-03), every command allowed** (the user's call). Not enforced: staying inside the copy (only asked in `editNote`). Safer options for later: Claude Code's sandbox (`--settings` with `sandbox` config; macOS/Linux/WSL only), an allow-list, or per-command approval (below). Nodes started before keep their old edit note, so they have the tool but weren't told to run commands in their copy.
- **Approval in the GUI:** `-p` mode refuses anything not pre-approved. `--permission-prompt-tool mcp__harness__approve` (a tool on our MCP server, `tools/harness.ts`) lets the harness show "Branch X wants to run `latexmk main.tex` — Allow once / Always for this project / Deny" instead of failing.
- **Apply automatically** unless there's a conflict (the user's idea for later); now Apply is always a separate step.
- **Apply conflicts:** Apply aborts on a conflict with the user's branch. Possible: a "resolve" child node whose copy merges the user's branch in (markers for the model to resolve), then Apply that.
- **Clean-up:** "Start over" leaves the old nodes' branches and worktrees (open nodes' copies under `.harness/work/`). A command to remove branches that are applied or belong to deleted nodes, with a confirm (never delete unapplied work silently).
- **API provider:** no file tools, so editing is Claude Code only (`LLMProvider.canEdit`). Could add Edit/Write as custom tools.
- **Prompt cache, measured:** sibling branches differ in `--allowedTools` (each allows its own copy) and in their MCP URL; `check:cache` runs them that way and they still share the cache (Haiku 4.5, CLI 2.1.287, 2026-10-03). Not yet re-measured on Sonnet/Opus.
- **Card counts go stale:** `nodes.files_changed` is computed after each reply and Apply; a commit by the user in between isn't reflected until then.
- **Uncommitted project changes:** nodes start from the last commit; the editing dialog warns when there are uncommitted changes, but nothing reminds later.
- **Per-reply diffs:** each reply is one commit on the node's branch, so "what did this reply change" could be shown under the reply.

Considered and dropped (2026-10-03): detached worktrees with hidden refs `refs/harness/<id>` (they only hide the branches from `git branch`, at the cost of moving the refs by hand after every commit and losing git's one-branch-per-worktree check), and acquire/release file locks in one shared folder (sibling branches would edit on top of each other, so they stop being separate alternatives; also starvation while waiting for the user, deadlocks, Claude Code's Edit tool not knowing the locks, and shell commands getting around them).

## 12. macOS and Linux support
The code is mostly portable already (Node, `node:sqlite`, paths via `node:path`, uploads split on both `\` and `/`). What's left:
- **Finding `claude`:** `findClaudeExecutable` only knows the Windows npm location, else `claude` on PATH. Add the native installer location (`~/.local/bin/claude`), npm global (`npm prefix -g`/bin), Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`). An Electron app started from Finder/a desktop launcher doesn't get the shell's PATH, so check these explicitly (or read the login shell's PATH once). Show a clear "Claude Code not found — install it or set its path" message in the GUI.
- **Tests:** some tests use Windows paths (`C:\…`, `D:\Research`) that mean something else on POSIX (e.g. `workspace.test.ts`); make them platform-neutral or per platform. Add a CI matrix (GitHub Actions: windows, macos, ubuntu) running typecheck, lint and tests.
- **Shell tool (item 11):** Bash on macOS/Linux, PowerShell/Git Bash on Windows; the system prompt should tell the model which OS and shell it has.
- **Case-sensitive file systems (Linux):** unique upload names and path checks must not assume case-insensitivity (`Paper.pdf` vs `paper.pdf`).
- **Electron packaging (roadmap step 3):** electron-builder targets `dmg` (+ code signing and notarization for macOS, needs an Apple Developer account), `AppImage`/`deb` for Linux, NSIS for Windows. Check `node:sqlite` in Electron's Node on each.
- **Folder dialog:** "Browse…" in the new-project dialog uses `osascript` on macOS and zenity/kdialog on Linux (`system/folder-picker.ts`); untested there.
- **Data folder:** use the OS's app-data location in the packaged app (`app.getPath('userData')`: `~/Library/Application Support/…`, `~/.config/…`, `%APPDATA%\…`) instead of the repo's `data/`; the dev setup keeps `data/`.

## 16. Supported Claude Code versions, and telling the user when theirs isn't
The Claude Code provider depends on details a CLI update can change without notice: flags (`--input-format stream-json`, `--include-partial-messages`, `--fork-session`, `--json-schema`, `--system-prompt`, `--setting-sources ''`, `--strict-mcp-config`, `--tools`); the stream-json event shapes (`system:init` with `session_id`, `stream_event` deltas, `tool_use`/`tool_result`, `rate_limit_event`, `result` with `structured_output`); the text format of WebSearch results (`Links: [...]`), and the internal `CLAUDE_CODE_TETHER_LIVE` variable that keeps forks cached (see item 14 under Done). Today a breaking update would show up as odd failures mid-research.
- **Define the range:** one constant in `llm/claude-code.ts`, e.g. `{ minimum: '2.1.287', testedUpTo: '2.1.287' }`.
  - Below `minimum`: **unsupported**. Don't start replies; say "Claude Code 2.0.x is too old for Harness; update it (`npm install -g @anthropic-ai/claude-code`, then run `node install.cjs` in the package folder on Windows)".
  - Between: fine.
  - Above `testedUpTo`: **untested**. Keep working, but show a quiet notice ("Claude Code 2.2.0 is newer than Harness was tested with; tell Claude if something breaks").
- **Detect the version:** run `claude --version` at server start and again when a node's process starts, cached for an hour (the CLI can update itself while the server runs). Also check whether the `system:init` event reports the version (not seen in 2.1.287's strings); if it does, compare on every run for free.
- **Check the flags, not just the number (free, no credit):** parse `claude --help` once per version and confirm every flag we pass exists. A missing flag means unsupported, whatever the number says.
- **Catch breakage at runtime:** treat "unknown option"/"unexpected argument" errors, an `init` without `session_id`, or a result draft without `structured_output` as a new error kind `version` ("Claude Code changed in a way Harness doesn't handle yet (version X)"), not a generic failure.
- **Where the user sees it:** the header chip (which now names the backend, "Claude Code") adds the version ("Claude Code 2.1.287"), with a warning style when untested or unsupported. A banner like the usage one on the graph and in chats explains it. `/api/health` returns `{ version, support: 'ok' | 'untested' | 'unsupported' }`.
- **Option: pin a version.** Install Claude Code as an exact-version dependency of the server instead of using the global install, so updates happen only when we bump it (`findClaudeExecutable` prefers the local copy). Setting `DISABLE_AUTOUPDATER=1` (the CLI knows this variable) for our runs avoids self-updates mid-run. npm 12 blocks the package's install script, so the setup must run `install.cjs` itself.
- **Raising `testedUpTo`:** an opt-in live check (`npm run check:claude`) that runs the real CLI once per feature (stream a short reply, fork a session, a result draft with `--json-schema`, a web search) for a few cents of credit, then compares the events with what `fake-claude.mjs` sends. Save the real output as fixtures per version, so the fake CLI stays faithful.
- **API provider too, briefly:** the SDK is pinned by `package-lock.json`, but model ids and beta headers (`server-side-fallback-2026-07-01`, the web tool versions) get retired. Classify "unknown beta"/"model not found" errors with a message that names what to update.

## 17. Record which provider a node's session id belongs to
- **Problem:** `nodes.session_id` is a bare string. `planSession` (`dag/session.ts`) resumes or forks whatever id is there, whichever provider is running. Today only Claude Code uses session ids, so it's harmless. But with a second session-based provider (e.g. OpenAI's Responses API with `previous_response_id`, or another CLI), switching `HARNESS_PROVIDER` would hand a Claude Code session id to that provider, and resuming would fail or do something unexpected.
- **Fix:** store the provider with the id (a `session_provider` column, or keep it next to the id), and later the folder too, since Claude Code sessions only resume from the folder that created them. `planSession` takes the current provider's `kind` and treats a session from another provider (or folder) as missing. It then falls back to the transcript replay that already exists for nodes with no session. Existing ids get `claude-code` in the migration (append-only: the ids are kept, just labelled).
- **Tests:** in `session.test.ts`, a node with a session from another provider gets `new` plus a transcript, not `resume`; a parent with a session from another provider isn't forked.
- Prepares the ground for mixing providers in one graph (one provider per node, not per app), which merges already allow because only results flow back.

## 18. Settings page
App settings are environment variables in `.env` for now (`HARNESS_PROVIDER`, `HARNESS_MODEL`, `HARNESS_EFFORT`, …), read at server start. A settings page (route `/settings`, planned in the project structure) should let the user change them in the app, stored in the database, without restarting.
- **First entry: the ask_node question limit** (`HARNESS_ASK_LIMIT`, default 3): how many questions to other nodes one message allows before the model needs approval (see "Question limit" in CLAUDE.md). Changing it never touches the prompt cache (the number isn't in the tool definitions). Maybe also the approval timeout (25 min now, must stay under the CLI's 30-minute MCP tool timeout).
- Later candidates: default model and effort, the provider, the placeholder delay for testing.

## Done
Implemented on 2026-10-02 (see CLAUDE.md for how they work). Leftovers worth doing later:
- **1. LaTeX support:** done (KaTeX rendering, delimiter safety net, prompt section). Left: syntax highlighting for code blocks, Mermaid diagrams; check whether resumed Claude Code sessions pick up the new system prompt.
- **2. Files per branch when forking:** done.
- **6. Rename and model-written titles:** done (pencil on cards and in the chat header, Suggest button, automatic title after the first reply, `title_source`).
- **7. Remember what was read in each node:** done (`read_upto` per node, opening position, "N new" badge on cards, follow-the-stream only at the bottom). Left: an unread marker line inside the chat at the first unread reply; marking read for results of finished branches.
- **5. Let the agent fork:** done. Without MCP: click list items, table rows or sections in a reply (one instruction for all, one branch per pick). With MCP (2026-10-03): the model's `fork_branches` tool proposes branches; the user reviews them in the pre-filled fork dialog. Leftovers in item 5 above. Possible extras: pick plain paragraphs, keyboard picking, keep the selection when leaving the chat, a "select all rows/items" shortcut.
- **13. Keep the in-between context in cross-level merges:** done (2026-10-03) as chosen: the merge note lists the conversations the merge leaves out (the merged branches and the nodes between them and the base) with their node ids, and the model asks them with `ask_node` (a throwaway fork of that node's session; only ancestors of the asking node). Pasting summaries up front was not chosen.
- **15. Fork from whole sections:** done (headings and bold lead-in lines; click the heading line to pick the section). Left: maybe ask the model in the system prompt to put alternative approaches under `###` headings.
- **9. Clear "limit reached" message:** done (classified errors, banner with reset time and share used, e.g. "25% of your weekly limit used", Retry and Retry all). Left: capture a real limit hit to confirm the event shapes (and the monthly `-p` credit wording); retry automatically when the limit resets.
- **10. One attach button:** done (paperclip with a Files/Folder menu).
- **8. Change model and effort while working:** done (model and effort per node; dropdowns under the composer that apply right away, with a note when the next reply re-reads the history without the cache; per-branch dropdowns in the fork dialog; dropdowns in the merge dialog, pre-filled with the branches' setting or, if their models differ, the first by name with a warning; model list from the API's Models endpoint or, on Claude Code, a fixed list of ids). The app always passes `--model` / `--effort`, because the account's own default changed from Opus to Sonnet on its own. A project default was built and dropped again (the root's setting plays that role). Left: see item 8 above.
- **Prompt-cache checks** (from item 8's work): tests that sibling forks start identically and get no leaked `CLAUDE*` variables, plus the live `npm run check:cache` (uses a little of the limit). It found item 14.
- **14. Claude Code forks and restarts missed the cache on Sonnet 5.5:** fixed. Cause: the CLI's "tether" (server-side Message Threads), enabled remotely for Sonnet 5.5 but not Opus 5.5; each CLI process got its own thread, so forks and resumes read only the system prompt from the cache. `cliEnv` sets `CLAUDE_CODE_TETHER_LIVE=false`; `check:cache` now requires forks, siblings started together and resumes to read the cache (passes on Sonnet 5.5). Left: store each reply's cache use (the `usage` event) per message and show the real cost ("read 19K from the cache, 3K new"); watch for the variable disappearing in a CLI update (item 16). How it was found: logging the CLI's requests through a local proxy (`ANTHROPIC_BASE_URL`) made the problem vanish, because tether is first-party only.
- **Multiple projects** (asked for directly, not a backlog item): done (sidebar, new project with an optional working folder picked in the OS folder dialog, rename, reopens the last project). Left: deleting a project (on purpose not built; it should back up first, like "Start over"); try the folder dialog on macOS and Linux (see item 12).
