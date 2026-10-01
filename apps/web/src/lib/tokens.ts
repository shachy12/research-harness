import type { BranchResult, ContextItem } from '@harness/shared'

/** Rough token estimate (about 4 characters per token), for display only. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export const resultText = (r: BranchResult) => [r.findings, r.evidence, r.openQuestions, r.confidence].join(' ')

export const contextTokens = (items: ContextItem[]) =>
  items.reduce(
    (sum, item) => sum + estimateTokens(item.kind === 'message' ? item.message.content : resultText(item.result)),
    0,
  )

export const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
