import ReactMarkdown from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { sectionItem } from './listItems'
import { rehypeSections } from './sections'

/** The sections found in `md`, as their source text, outermost first, in reading order. */
function sections(md: string): string[] {
  const found: string[] = []
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSections]}
      components={{
        section: ({ node, children }) => {
          found.push(md.slice(node!.position!.start.offset, node!.position!.end.offset))
          return <section>{children}</section>
        },
      }}
    >
      {md}
    </ReactMarkdown>,
  )
  return found
}

const reply = [
  'Intro text.',
  '',
  '## Suggested approaches',
  '',
  '**1. Reduce arithmetic to linear (the most promising first step).**',
  '- Take the degree-1 part',
  '- Privacy is preserved',
  '',
  '**2. Subspace arguments:**',
  '',
  'Let $V_q$ be the row space.',
  '',
  '## Next steps',
  '',
  'Read the paper.',
].join('\n')

describe('rehypeSections', () => {
  it('groups headings and bold lead-in lines with what follows them, nested by level', () => {
    expect(sections(reply)).toEqual([
      reply.slice(reply.indexOf('## Suggested'), reply.indexOf('row space.') + 'row space.'.length),
      '**1. Reduce arithmetic to linear (the most promising first step).**\n- Take the degree-1 part\n- Privacy is preserved',
      '**2. Subspace arguments:**\n\nLet $V_q$ be the row space.',
      '## Next steps\n\nRead the paper.',
    ])
  })

  it('ends a section at a heading of the same or a higher level, not a deeper one', () => {
    const md = '# A\n\n## B\n\ntext\n\n### C\n\nmore\n\n## D\n\nend'
    expect(sections(md)).toEqual(['# A\n\n## B\n\ntext\n\n### C\n\nmore\n\n## D\n\nend', '## B\n\ntext\n\n### C\n\nmore', '### C\n\nmore', '## D\n\nend'])
  })

  it('a section can jump heading levels and can end the reply', () => {
    expect(sections('#### Deep\n\nx\n\n## Shallow')).toEqual(['#### Deep\n\nx', '## Shallow'])
  })

  it('ignores bold lines inside lists and paragraphs that only start with bold text', () => {
    expect(sections('- **Bold item**\n  - sub\n\n**Idea.** More text here.\n\nplain')).toEqual([])
  })
})

describe('sectionItem', () => {
  const item = (from: string, through: string) =>
    sectionItem(reply, reply.indexOf(from), reply.indexOf(through) + through.length)

  it('keeps the Markdown and titles it by the heading without marks or numbering', () => {
    expect(item('**1. Reduce', 'preserved')).toEqual({
      text: '**1. Reduce arithmetic to linear (the most promising first step).**\n- Take the degree-1 part\n- Privacy is preserved',
      title: 'Reduce arithmetic to linear (the most promising first step)',
    })
    expect(item('**2. Sub', 'row space.')?.title).toBe('Subspace arguments')
    expect(item('## Next', 'paper.')?.title).toBe('Next steps')
  })
})
