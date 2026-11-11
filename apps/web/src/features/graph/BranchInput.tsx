import { Autocomplete } from '@base-ui/react/autocomplete'
import { cn } from '@/lib/utils'

/**
 * A text field for a git branch name that suggests matching existing branches as you type (any
 * name can be typed; a new one is created). Base UI's Autocomplete: the list filters itself by
 * what is typed, and picking a suggestion fills the field.
 */
export function BranchInput({ id, value, branches, onChange, placeholder, autoFocus, invalid }: {
  id: string
  value: string
  /** Existing branches to suggest, most relevant first. */
  branches: string[]
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  invalid?: boolean
}) {
  return (
    <Autocomplete.Root items={branches} value={value} onValueChange={(v) => onChange(v)} openOnInputClick>
      <Autocomplete.Input
        id={id}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        className={cn(
          'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 font-mono text-sm transition-colors outline-none',
          'placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30',
        )}
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="isolate z-50 outline-none" sideOffset={4}>
          <Autocomplete.Popup className="max-h-[min(16rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-empty:hidden">
            <Autocomplete.List>
              {(branch: string) => (
                <Autocomplete.Item
                  key={branch}
                  value={branch}
                  className="flex cursor-default items-center rounded-md px-2 py-1 font-mono text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {branch}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}
