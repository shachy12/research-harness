const KEY = 'harness.lastProject'

/** Remember the open project, so the app reopens it next time (a convenience; may be unavailable). */
export function rememberProject(projectId: string) {
  try {
    localStorage.setItem(KEY, projectId)
  } catch {
    // storage blocked: the app then opens the most recently used project
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}
