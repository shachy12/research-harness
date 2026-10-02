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
*(Interpreted as the Finish-branch summary; confirm.)* "Finish branch" currently shows "Drafting the result…" until the whole draft arrives, which can take a while on Opus.
- Show the model writing the draft as it goes, like replies in the chat, then turn it into the editable form when done.
- **Claude Code:** the draft is a one-shot `--json-schema` run; switch it to `--output-format stream-json --include-partial-messages` and stream the text (the structured result arrives at the end).
- **API provider:** stream with the SDK instead of `messages.parse`, then parse the final JSON.
- **Server/UI:** the draft endpoint streams server-sent events (like chat replies); `ResultDialog` shows the text live, with the activity line and timer, then fills the fields.
- Partial JSON isn't pleasant to read: consider streaming a readable Markdown draft first and extracting the fields at the end, or showing the fields filling in as the JSON arrives.
