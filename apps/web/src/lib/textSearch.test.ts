import { describe, expect, it } from 'vitest'
import { findMatches, type TextPiece } from './textSearch'

const inline = (...texts: string[]): TextPiece[] => texts.map((text) => ({ text, newBlock: false }))

describe('findMatches', () => {
  it('finds every match, ignoring case', () => {
    expect(findMatches(inline('The LPN bound and the lpn rate'), 'lpn')).toEqual([
      { start: { piece: 0, offset: 4 }, end: { piece: 0, offset: 7 } },
      { start: { piece: 0, offset: 22 }, end: { piece: 0, offset: 25 } },
    ])
  })

  it('finds a match running across inline pieces (bold inside a sentence)', () => {
    expect(findMatches(inline('a very ', 'fast', ' database'), 'fast data')).toEqual([
      { start: { piece: 1, offset: 0 }, end: { piece: 2, offset: 5 } },
    ])
  })

  it('ends a match at the end of a piece, not at offset 0 of the next', () => {
    expect(findMatches(inline('GPU', ' versus CPU'), 'gpu')).toEqual([
      { start: { piece: 0, offset: 0 }, end: { piece: 0, offset: 3 } },
    ])
  })

  it('never joins two blocks', () => {
    const pieces = [{ text: 'end of one', newBlock: true }, { text: 'start of two', newBlock: true }]
    expect(findMatches(pieces, 'one start')).toEqual([])
    expect(findMatches(pieces, 'start')).toHaveLength(1)
  })

  it('finds nothing for an empty or blank query', () => {
    expect(findMatches(inline('anything'), '')).toEqual([])
    expect(findMatches(inline('anything'), '   ')).toEqual([])
  })

  it('does not overlap matches', () => {
    expect(findMatches(inline('aaaa'), 'aa')).toHaveLength(2)
  })

  it('keeps offsets right after a character whose lower case is longer', () => {
    expect(findMatches(inline('İstanbul cache'), 'cache')).toEqual([
      { start: { piece: 0, offset: 9 }, end: { piece: 0, offset: 14 } },
    ])
  })
})
