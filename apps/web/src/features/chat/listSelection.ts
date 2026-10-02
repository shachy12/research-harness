import { createContext, useContext, useState } from 'react'
import { type SelectedItem, itemKey } from '@/lib/listItems'

/** The list items ticked in a node's replies, to fork them into branches. Lives with the chat page. */
export interface ListSelection {
  items: SelectedItem[]
  toggle: (item: SelectedItem) => void
  clear: () => void
}

export const ListSelectionContext = createContext<ListSelection | null>(null)

/** Null outside a chat (e.g. a Markdown preview), where list items are not selectable. */
export const useListSelection = () => useContext(ListSelectionContext)

export function useListSelectionState(): ListSelection {
  const [items, setItems] = useState<SelectedItem[]>([])
  return {
    items,
    toggle: (item) =>
      setItems((list) => {
        const key = itemKey(item.messageId, item.start)
        return list.some((i) => itemKey(i.messageId, i.start) === key)
          ? list.filter((i) => itemKey(i.messageId, i.start) !== key)
          : [...list, item]
      }),
    clear: () => setItems([]),
  }
}
