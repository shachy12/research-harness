import { describe, expect, it } from 'vitest'
import { prepareMath } from './math'

describe('prepareMath', () => {
  it.each([
    ['area $x^2$ here', 'area $x^2$ here'],
    ['$n$-th and $O(n)$', '$n$-th and $O(n)$'],
    ['$\\{0,1\\}^n$ bits', '$\\{0,1\\}^n$ bits'],
    ['$$\na=b\n$$', '$$\na=b\n$$'],
  ])('keeps math: %j', (input, output) => {
    expect(prepareMath(input)).toBe(output)
  })

  it.each([
    ['costs $5 and $10', 'costs \\$5 and \\$10'],
    ['between $1 and $2.', 'between \\$1 and \\$2.'],
    ['costs $5, while $x^2$ grows', 'costs \\$5, while $x^2$ grows'],
    ['already \\$5', 'already \\$5'],
    ['streaming $x^', 'streaming \\$x^'],
  ])('keeps prices as text: %j', (input, output) => {
    expect(prepareMath(input)).toBe(output)
  })

  it('converts \\( \\) and \\[ \\] delimiters', () => {
    expect(prepareMath('inline \\(a+b\\) ok')).toBe('inline $a+b$ ok')
    expect(prepareMath('display \\[ \\sum_i x_i \\] end')).toBe('display \n$$\n\\sum_i x_i\n$$\n end')
  })

  it('puts a one-line $$…$$ on its own lines, so it is displayed', () => {
    expect(prepareMath('Sum:\n\n$$\\sum_i i$$\n\nmore')).toBe('Sum:\n\n$$\n\\sum_i i\n$$\n\nmore')
    expect(prepareMath('inline $$x$$ here')).toBe('inline $$x$$ here')
  })

  it('keeps a displayed equation inside its list item', () => {
    expect(prepareMath('3. where\n   $$p:=1$$\n   and')).toBe('3. where\n   $$\n   p:=1\n   $$\n   and')
    expect(prepareMath('- see \\[x\\] ok')).toBe('- see \n  $$\n  x\n  $$\n ok')
  })

  it('leaves code alone', () => {
    const text = 'code `$x$` and ```latex\n\\(a\\) $5 $6\n```'
    expect(prepareMath(text)).toBe(text)
  })
})
