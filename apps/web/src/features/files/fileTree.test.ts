import { describe, expect, it } from 'vitest'
import { buildTree, parentFolders, projectPath } from './fileTree'
import { StringStream } from '@codemirror/language'
import { bibtexParser, languageFor, wrapsLines } from './codeTheme'

describe('buildTree', () => {
  it('nests folders, folders first, names in a natural order', () => {
    const tree = buildTree(['main.tex', 'sections/intro.tex', 'B.txt', 'a.txt', 'sections/fig/2.png', 'file10', 'file2', 'main.tex'])
    expect(tree.folders.map((f) => f.path)).toEqual(['sections'])
    expect(tree.files.map((f) => f.name)).toEqual(['a.txt', 'B.txt', 'file2', 'file10', 'main.tex'])
    const sections = tree.folders[0]
    expect(sections.folders.map((f) => [f.name, f.path])).toEqual([['fig', 'sections/fig']])
    expect(sections.files).toEqual([{ name: 'intro.tex', path: 'sections/intro.tex' }])
    expect(sections.folders[0].files.map((f) => f.path)).toEqual(['sections/fig/2.png'])
  })
})

describe('parentFolders', () => {
  it('lists the folders above a path, outermost first', () => {
    expect(parentFolders('a/b/c.txt')).toEqual(['a', 'a/b'])
    expect(parentFolders('c.txt')).toEqual([])
  })
})

describe('projectPath', () => {
  it('maps repository paths to the project folder inside the repository', () => {
    expect(projectPath('notes.md', '')).toBe('notes.md')
    expect(projectPath('paper/notes.md', 'paper')).toBe('notes.md')
    expect(projectPath('other/notes.md', 'paper')).toBeNull()
    expect(projectPath('paperback/x', 'paper')).toBeNull()
  })
})

describe('languages', () => {
  it('finds highlighting by file name, BibTeX included', async () => {
    expect(await languageFor('refs.bib')).not.toBeNull()
    expect(await languageFor('src/analysis.py')).not.toBeNull()
    expect(await languageFor('notes.unknownext')).toBeNull()
  })

  it('colours BibTeX entries: type, key, field names, values', () => {
    const state = bibtexParser.startState!(2)
    const tokens = (line: string) => {
      const stream = new StringStream(line, 4, 2)
      const out: [string, string | null][] = []
      while (!stream.eol()) {
        stream.start = stream.pos
        const style = bibtexParser.token(stream, state)
        if (stream.current().trim()) out.push([stream.current(), style])
      }
      return out
    }
    expect(tokens('@article{child2019,')).toEqual([['@article', 'keyword'], ['{', 'bracket'], ['child2019', 'labelName'], [',', null]])
    expect(tokens('  title = {Sparse {T}ransformers},')).toEqual([
      ['title', 'propertyName'], ['=', null], ['{', 'string'], ['Sparse ', 'string'], ['{', 'string'], ['T', 'string'], ['}', 'string'],
      ['ransformers', 'string'], ['}', 'string'], [',', null],
    ])
    expect(tokens('}')).toEqual([['}', 'bracket']])
    expect(tokens('A note between entries')).toEqual([['A note between entries', 'comment']])
  })

  it('wraps prose files but not code', () => {
    expect(wrapsLines('sections/intro.tex')).toBe(true)
    expect(wrapsLines('README.md')).toBe(true)
    expect(wrapsLines('analysis.py')).toBe(false)
  })
})
