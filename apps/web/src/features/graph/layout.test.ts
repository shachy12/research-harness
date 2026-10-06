import type { DagNode } from '@harness/shared'
import { describe, expect, it } from 'vitest'
import { layoutGraph } from './layout'

const node = (id: string, parentIds: string[] = []) => ({ id, parentIds }) as DagNode

describe('layoutGraph', () => {
  it('puts every root on the top row, also one that only feeds a deep merge', () => {
    // root → a → b → c; orphan (e.g. its parent was deleted) is merged with c into m.
    const nodes = [node('root'), node('a', ['root']), node('b', ['a']), node('c', ['b']), node('orphan'), node('m', ['c', 'orphan'])]
    const y = (id: string) => layoutGraph(nodes).get(id)!.y
    expect(y('orphan')).toBe(y('root'))
    expect(y('a')).toBeGreaterThan(y('root'))
    expect(y('m')).toBeGreaterThan(y('c'))
  })

  it('places children below their parents and roots side by side', () => {
    const positions = layoutGraph([node('r1'), node('r2'), node('x', ['r1'])])
    expect(positions.get('r1')!.y).toBe(positions.get('r2')!.y)
    expect(positions.get('r1')!.x).not.toBe(positions.get('r2')!.x)
    expect(positions.get('x')!.y).toBeGreaterThan(positions.get('r1')!.y)
    expect(positions.has('__top__')).toBe(false)
  })
})
