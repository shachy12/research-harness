/** Split a unified diff into one piece per file, keyed by its new path. */
export function splitDiff(diff: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk)
    if (header) files.set(header[1], chunk)
  }
  return files
}
