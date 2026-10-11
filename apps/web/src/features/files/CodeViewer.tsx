import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Extension } from '@codemirror/state'
import { codeTheme, languageFor, wrapsLines } from './codeTheme'

/**
 * A read-only view of one file with line numbers and colours for its type (CodeMirror 6). Text can
 * be selected and copied, and Ctrl+F searches it. Editing happens in VS Code.
 *
 * CodeMirror isn't a React component: it draws into a DOM element itself. The effect creates it
 * there and destroys it when the file changes or the view goes away. New text of the same file (a
 * reply editing it while it's shown) only replaces what changed, so the scroll position stays.
 */
export function CodeViewer({ path, text }: { path: string; text: string }) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The text when the editor is made (later text arrives through the effect below).
  const currentText = useEffectEvent(() => text)
  // The language loads on demand (a separate download per language), so it arrives a moment later.
  const [language, setLanguage] = useState<{ path: string; ext: Extension | null } | null>(null)

  useEffect(() => {
    let live = true
    languageFor(path)
      .catch(() => null)
      .then((ext) => live && setLanguage({ path, ext }))
    return () => {
      live = false
    }
  }, [path])

  const ext = language?.path === path ? language.ext : null
  useEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: currentText(),
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          drawSelection(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          codeTheme,
          wrapsLines(path) ? EditorView.lineWrapping : [],
          ext ?? [],
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [path, ext])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const old = editor.state.doc.toString()
    const next = text.replace(/\r\n?/g, '\n') // CodeMirror keeps lines joined by \n
    if (old === next) return
    // Replace only the part between what the old and new text share at the start and the end.
    let start = 0
    while (start < old.length && start < next.length && old[start] === next[start]) start++
    let end = 0
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++
    editor.dispatch({ changes: { from: start, to: old.length - end, insert: next.slice(start, next.length - end) } })
  }, [text])

  return <div ref={parent} className="h-full min-h-0" data-testid="code-viewer" />
}
