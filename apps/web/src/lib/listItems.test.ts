import { describe, expect, it } from 'vitest'
import { type SelectedItem, composeBranchPrompt, itemSource, itemTitle, resolveSelection, splitRow, tableRowItem } from './listItems'

/** The item whose marker starts at the first occurrence of `from` in `md`, up to the end of `through`. */
const slice = (md: string, from: string, through: string) => {
  const start = md.indexOf(from)
  return itemSource(md, start, md.indexOf(through, start) + through.length)
}

describe('itemSource', () => {
  const md = [
    'Directions:',
    '',
    '1. Use a hybrid argument',
    '   over the key schedule',
    '   - needs adaptive PRF security',
    '   - loses a factor of q',
    '2. Reduce to the PRF assumption',
    '',
  ].join('\n')

  it('drops the marker and keeps what is under the item, de-indented', () => {
    expect(slice(md, '1. Use', 'factor of q')).toBe(
      'Use a hybrid argument\nover the key schedule\n- needs adaptive PRF security\n- loses a factor of q',
    )
  })

  it('works for a single-line item and for bullets', () => {
    expect(slice(md, '2. Reduce', 'assumption')).toBe('Reduce to the PRF assumption')
    expect(slice('* point one\n* point two', '* point two', 'two')).toBe('point two')
  })

  it('de-indents a nested item relative to its own marker', () => {
    expect(slice(md, '- needs', 'security')).toBe('needs adaptive PRF security')
    const nested = '- outer\n  - inner\n    more of inner\n    ```\n    code\n    ```'
    expect(itemSource(nested, nested.indexOf('- inner'), nested.length)).toBe('inner\nmore of inner\n```\ncode\n```')
  })

  it('does not include a task-list box', () => {
    expect(slice('- [ ] read the paper', '- [ ]', 'paper')).toBe('read the paper')
    expect(slice('- [x] done', '- [x]', 'done')).toBe('done')
  })
})

describe('resolveSelection', () => {
  const item = (messageId: string, start: number, end: number): SelectedItem => ({ messageId, start, end, text: `${messageId}@${start}` })

  it('puts items in reading order across messages', () => {
    const picked = [item('m2', 5, 9), item('m1', 30, 40), item('m1', 10, 20)]
    expect(resolveSelection(picked, ['m1', 'm2']).map((i) => i.text)).toEqual(['m1@10', 'm1@30', 'm2@5'])
  })

  it('drops an item that sits inside another ticked item, but only in the same message', () => {
    const parent = item('m1', 10, 100)
    const child = item('m1', 40, 60)
    const sibling = item('m1', 100, 120)
    const other = item('m2', 40, 60)
    expect(resolveSelection([child, parent, sibling, other], ['m1', 'm2']).map((i) => i.text)).toEqual(['m1@10', 'm1@100', 'm2@40'])
  })

  it('keeps a ticked child when its parent is not ticked', () => {
    expect(resolveSelection([item('m1', 40, 60)], ['m1'])).toHaveLength(1)
  })
})

describe('composeBranchPrompt', () => {
  it('appends the item after the instruction', () => {
    expect(composeBranchPrompt('Check this one.', 'Hybrid argument')).toBe('Check this one.\n\nHybrid argument')
  })

  it('places the item where {item} is, every time', () => {
    expect(composeBranchPrompt('Compare {item} with §3, then explain why {item} fails', 'X')).toBe('Compare X with §3, then explain why X fails')
  })

  it('sends the item alone without an instruction', () => {
    expect(composeBranchPrompt('  ', 'Hybrid argument')).toBe('Hybrid argument')
  })
})

describe('itemTitle', () => {
  it('uses the first line as plain text', () => {
    expect(itemTitle('**Hybrid argument** over the `key schedule`\n- detail')).toBe('Hybrid argument over the key schedule')
    expect(itemTitle('See [the paper](https://example.org) for _details_')).toBe('See the paper for details')
  })

  it('shortens long titles', () => {
    expect(itemTitle('word '.repeat(40)).length).toBeLessThanOrEqual(81)
  })

  it('leaves snake_case and math alone', () => {
    expect(itemTitle('Use snake_case_names and $a_i$')).toBe('Use snake_case_names and $a_i$')
  })
})

describe('table rows', () => {
  const md = [
    'Known attacks:',
    '',
    '| Attack | Idea | Notes |',
    '|---|:---:|---|',
    '| **Gauss / Prange-style** | Pick $n$ samples, hope all are error-free | Time about $2^{n}$ |',
    '| Pooled Gauss | Keep a pool of $m>n$ samples | |',
    '',
    'After the table.',
  ].join('\n')
  const row = (first: string) => {
    const start = md.indexOf(first)
    return tableRowItem(md, start, md.indexOf('\n', start))
  }

  it('labels each cell with its column and names the branch after the first cell', () => {
    expect(row('| **Gauss')).toEqual({
      text: 'Attack: **Gauss / Prange-style**\nIdea: Pick $n$ samples, hope all are error-free\nNotes: Time about $2^{n}$',
      title: 'Gauss / Prange-style',
    })
  })

  it('leaves out empty cells', () => {
    expect(row('| Pooled')).toEqual({ text: 'Attack: Pooled Gauss\nIdea: Keep a pool of $m>n$ samples', title: 'Pooled Gauss' })
  })

  it('ignores cells beyond the header, like GFM does', () => {
    const wide = '| A | B |\n|---|---|\n| 1 | 2 | 3 |'
    expect(tableRowItem(wide, wide.indexOf('| 1'), wide.length)?.text).toBe('A: 1\nB: 2')
  })

  it('works without a header it can find', () => {
    expect(tableRowItem('| x | y |', 0, 9)?.text).toBe('x\ny')
  })

  it('splits on unescaped pipes only', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
    expect(splitRow('a | b')).toEqual(['a', 'b'])
  })
})
