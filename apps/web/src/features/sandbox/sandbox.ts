import { type SandboxSettings, type SandboxStatus, SANDBOX_AUTH_VARIABLES } from '@harness/shared'

/** The project's settings pass a variable that logs in or picks a provider (then no token is needed). */
export function passesAuth(settings: SandboxSettings | undefined): boolean {
  return !!settings?.env.some((name) => SANDBOX_AUTH_VARIABLES.includes(name))
}

/** What keeps the project's sandboxes from starting, in a few words (null: nothing known). */
export function sandboxProblem(status: SandboxStatus, settings: SandboxSettings | undefined): string | null {
  switch (status.docker.state) {
    case 'ready':
      return status.token || passesAuth(settings) ? null : 'No Claude login for the sandbox yet'
    case 'not-installed':
      return 'Docker is not installed'
    case 'not-running':
      return 'Docker is not running'
    case 'no-permission':
      return 'Your user may not use Docker'
    default:
      return 'Docker is not answering'
  }
}
