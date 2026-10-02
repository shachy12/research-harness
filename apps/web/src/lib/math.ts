/**
 * Prepare model output for math rendering (remark-math + KaTeX):
 * - `\(…\)` becomes `$…$` and `\[…\]` becomes a `$$…$$` block (Claude sometimes uses those);
 * - a `$` that can't be inline math (e.g. "costs $5 and $10") is escaped, so prices stay text.
 * Code (fenced blocks and `inline code`) is left exactly as it is.
 *
 * The inline rule is Pandoc's: an opening `$` has a non-space character right after it, the closing
 * `$` has a non-space character right before it and no digit right after, both on the same line.
 */
export function prepareMath(text: string): string {
  // Split off code: fenced blocks (possibly still open while streaming) and inline code spans.
  const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
  return parts.map((part, i) => (i % 2 === 1 ? part : prepareProse(part))).join('')
}

function prepareProse(text: string): string {
  const converted = text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\((.+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)

  let out = ''
  let i = 0
  while (i < converted.length) {
    const ch = converted[i]
    if (ch === '\\' && i + 1 < converted.length) {
      out += ch + converted[i + 1] // an escaped character, e.g. \$
      i += 2
      continue
    }
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    if (converted[i + 1] === '$') {
      // Display math: keep everything up to the closing $$ (or the rest, while it streams in).
      const end = converted.indexOf('$$', i + 2)
      const stop = end === -1 ? converted.length : end + 2
      const lineStart = converted.lastIndexOf('\n', i - 1) + 1
      const lineEnd = converted.indexOf('\n', stop)
      const ownLine =
        end !== -1 &&
        !converted.slice(lineStart, i).trim() &&
        !converted.slice(stop, lineEnd === -1 ? undefined : lineEnd).trim()
      // On a line of its own, `$$…$$` is a displayed equation; remark-math needs the $$ on their
      // own lines for that (otherwise it renders inline).
      out += ownLine ? `$$\n${converted.slice(i + 2, end).trim()}\n$$` : converted.slice(i, stop)
      i = stop
      continue
    }
    const close = inlineClose(converted, i)
    if (close === -1) {
      out += '\\$'
      i++
    } else {
      out += converted.slice(i, close + 1)
      i = close + 1
    }
  }
  return out
}

/** Where the inline math opened at `open` ends, or -1 if this `$` isn't math. */
function inlineClose(text: string, open: number): number {
  const first = text[open + 1]
  if (first === undefined || /\s/.test(first)) return -1
  for (let j = open + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '\n') return -1
    if (ch === '\\') {
      j++
      continue
    }
    if (ch !== '$') continue
    const valid = !/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? '') && text[j + 1] !== '$'
    return valid ? j : -1
  }
  return -1
}
