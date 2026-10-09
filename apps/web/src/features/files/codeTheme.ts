import { HighlightStyle, LanguageDescription, StreamLanguage, type StreamParser, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * Colours of the Files view. They are CSS variables (`--syntax-*` in index.css) with a light and a
 * dark value, so the code follows the app's theme without rebuilding the viewer.
 */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.inserted], color: 'var(--syntax-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syntax-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.propertyName, t.attributeName, t.labelName], color: 'var(--syntax-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.name)], color: 'var(--syntax-type)' },
  { tag: [t.heading, t.strong], color: 'var(--syntax-heading)', fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--syntax-function)', textDecoration: 'underline' },
  { tag: [t.deleted, t.invalid], color: 'var(--destructive)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--foreground)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklch, var(--primary) 25%, transparent) !important' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklch, var(--primary) 14%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--status-merge) 30%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, var(--status-merge) 55%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)', fontSize: '13px' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-textfield': { border: '1px solid var(--input)', borderRadius: '6px', backgroundColor: 'var(--background)', padding: '2px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--background)', border: '1px solid var(--input)', borderRadius: '6px' },
})

export const codeTheme: Extension = [theme, syntaxHighlighting(highlight)]

/**
 * BibTeX, which CodeMirror's language list doesn't have: entry types (`@article`), field names,
 * and values in braces or quotes.
 */
export const bibtexParser: StreamParser<{ depth: number }> = {
  name: 'bibtex',
  startState: () => ({ depth: 0 }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (state.depth === 0 && stream.peek() !== '{') {
      if (stream.match(/^@\w+/)) return 'keyword'
      stream.eatWhile(/[^@{]/) // text between entries is a comment in BibTeX
      return 'comment'
    }
    if (state.depth === 1 && stream.match(/^[\w-]+(?=\s*=)/)) return 'propertyName'
    const ch = stream.next()
    if (ch === '{') return ++state.depth > 1 ? 'string' : 'bracket'
    if (ch === '}') return --state.depth >= 1 ? 'string' : 'bracket'
    if (state.depth > 1) {
      stream.eatWhile(/[^{}]/)
      return 'string'
    }
    if (ch === '"') {
      stream.eatWhile(/[^"]/)
      stream.next()
      return 'string'
    }
    if (ch && /\d/.test(ch)) {
      stream.eatWhile(/\d/)
      return 'number'
    }
    stream.eatWhile(/[^\s{}=,"]/)
    return state.depth === 1 && ch !== ',' && ch !== '=' ? 'labelName' : null
  },
}
const bibtex = StreamLanguage.define(bibtexParser)

/** Prose-like files are wrapped; code keeps its lines. */
export function wrapsLines(path: string): boolean {
  return /\.(tex|ltx|sty|cls|bib|md|markdown|txt|rst|org|adoc)$/i.test(path)
}

/** The highlighting for a file, by its name (loaded on demand); null: plain text. */
export async function languageFor(path: string): Promise<Extension | null> {
  const name = path.split('/').pop() ?? path
  if (/\.bib$/i.test(name)) return bibtex
  const description = LanguageDescription.matchFilename(languages, name)
  return description ? description.load() : null
}
