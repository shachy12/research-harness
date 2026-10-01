/** Apply the `dark` class (used by the theme tokens) whenever the OS is in dark mode. */
export function followSystemTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', media.matches)
  apply()
  media.addEventListener('change', apply)
}
