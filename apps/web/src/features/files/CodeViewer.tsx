import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import type { Extension } from '@codemirror/state'
import { codeTheme, languageFor, wrapsLines } from './codeTheme'

/**
 * A read-only view of one file with line numbers and colours for its type (CodeMirror 6). Text can
 * be selected and copied, and Ctrl+F searches it. Editing happens in VS Code.
 *
 * CodeMirror isn't a React component: it draws into a DOM element itself. The effect creates it
 * there and destroys it when the file changes or the view goes away.
 */
export function CodeViewer({ path, text }: { path: string; text: string }) {
  const parent = useRef<HTMLDivElement>(null)
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
    const view = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: text,
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
    return () => view.destroy()
  }, [path, text, ext])

  return <div ref={parent} className="h-full min-h-0" data-testid="code-viewer" />
}
