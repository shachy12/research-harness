import { Button } from '@/components/ui/button'
import type { SelectedItem } from '@/lib/listItems'

/** Shown above the composer while list items are ticked: fork them into branches, or start over. */
export function SelectionBar({ picked, ticked, disabled, onFork, onClear }: {
  /** The branches the ticked items would become. */
  picked: SelectedItem[]
  /** How many items are ticked, including ones that sit inside another ticked item. */
  ticked: number
  disabled: boolean
  onFork: () => void
  onClear: () => void
}) {
  if (picked.length === 0) return null
  const included = ticked - picked.length
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <b>{picked.length}</b> {picked.length === 1 ? 'item' : 'items'} selected
        {included > 0 && (
          <span className="text-muted-foreground">
            {' '}
            · {included} ticked sub-{included === 1 ? 'item is' : 'items are'} already inside {included === 1 ? 'its' : 'their'} parent
          </span>
        )}
      </span>
      <Button size="sm" disabled={disabled} onClick={onFork} title={disabled ? 'Wait for the reply to finish' : undefined}>
        ⑂ Fork…
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  )
}
