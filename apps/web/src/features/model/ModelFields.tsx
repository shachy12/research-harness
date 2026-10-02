import type { Effort, ModelsResponse } from '@harness/shared'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { type ModelSettings, effortsFor, withModel } from './modelSettings'

// Select values are strings; this one stands for "no setting of its own" (null).
const DEFAULT = '__default__'

/** Two dropdowns: the model (by id) and its effort level. Each has a "Default" choice (null). */
export function ModelFields({ value, catalog, onChange, idPrefix, compact = false, disabled = false }: {
  value: ModelSettings
  catalog: ModelsResponse
  onChange: (value: ModelSettings) => void
  /** Makes the labels' ids unique when several sets are on one page. */
  idPrefix: string
  /** Small, on one line without visible labels (composer, fork dialog). */
  compact?: boolean
  disabled?: boolean
}) {
  const efforts = effortsFor(value, catalog)
  // The default choice shows what it stands for, e.g. "claude-opus-5-5 (default)".
  const modelLabel = (id: string) => (id === DEFAULT ? `${catalog.defaultModel} (default)` : id)
  const effortLabel = (id: string) => (id === DEFAULT ? `${catalog.defaultEffort} (default)` : id)
  const size = compact ? 'sm' : 'default'

  return (
    <div className={cn('flex flex-wrap gap-2', compact ? 'items-center' : 'items-end')}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-model`} className={cn(compact && 'sr-only')}>Model</Label>
        <Select
          disabled={disabled}
          value={value.model ?? DEFAULT}
          onValueChange={(v) => onChange(withModel(value, v === DEFAULT || v === null ? null : String(v), catalog))}
        >
          <SelectTrigger id={`${idPrefix}-model`} size={size} className="min-w-44" title="Model for the next replies">
            <SelectValue>{(v: string) => modelLabel(v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{modelLabel(DEFAULT)}</SelectItem>
            {catalog.models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {efforts.length > 0 ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-effort`} className={cn(compact && 'sr-only')}>Effort</Label>
          <Select
            disabled={disabled}
            value={value.effort ?? DEFAULT}
            onValueChange={(v) => onChange({ ...value, effort: v === DEFAULT || v === null ? null : (v as Effort) })}
          >
            <SelectTrigger id={`${idPrefix}-effort`} size={size} className="min-w-28" title="Effort for the next replies">
              <SelectValue>{(v: string) => effortLabel(v)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{effortLabel(DEFAULT)}</SelectItem>
              {efforts.map((e) => (
                <SelectItem key={e} value={e}>{e}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <span className={cn('text-xs text-muted-foreground', !compact && 'pb-2')}>No effort setting for this model</span>
      )}
    </div>
  )
}
