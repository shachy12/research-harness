/**
 * Find a search term in text that the page splits into pieces (DOM text nodes): a word in bold
 * inside a sentence is three pieces, and a match may run across them. Pieces in different blocks
 * (paragraphs, list items, table cells) are kept apart, so a match never joins the end of one
 * paragraph to the start of the next.
 */
export interface TextPiece {
  text: string
  /** The piece starts a new block (a different paragraph, cell, … than the one before). */
  newBlock: boolean
}

/** Where a match starts and ends: a piece index and an offset in that piece's text. */
export interface TextMatch {
  start: { piece: number; offset: number }
  end: { piece: number; offset: number }
}

/** Every match of `query` in reading order, ignoring case. Matches don't overlap. */
export function findMatches(pieces: TextPiece[], query: string): TextMatch[] {
  const needle = fold(query.trim())
  if (!needle) return []

  // Join the pieces, with a line break between blocks (the query has none, so it can't match
  // across one), and remember where each piece starts in the joined text.
  let joined = ''
  const starts: number[] = []
  pieces.forEach((p, i) => {
    if (p.newBlock && i > 0) joined += '\n'
    starts.push(joined.length)
    joined += fold(p.text)
  })

  const locate = (at: number, isEnd: boolean) => {
    // The last piece starting at or before `at` (for an end: before it, so a match ending exactly
    // where a piece starts ends in the piece before).
    let piece = 0
    for (let i = 0; i < starts.length; i++) {
      if (isEnd ? starts[i] < at : starts[i] <= at) piece = i
      else break
    }
    return { piece, offset: at - starts[piece] }
  }

  const matches: TextMatch[] = []
  for (let at = joined.indexOf(needle); at !== -1; at = joined.indexOf(needle, at + needle.length)) {
    matches.push({ start: locate(at, false), end: locate(at + needle.length, true) })
  }
  return matches
}

/**
 * Lower case, keeping the length (offsets must stay valid): a character whose lower case is
 * longer (rare, e.g. "İ") is kept as it is.
 */
function fold(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  return [...text].map((ch) => (ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch)).join('')
}
