import { useState } from 'react'
import { type PickedItems, readDrop } from './dropped-files'

/**
 * Accept dropped files and folders on an element: spread `props` on it, and show a hint while
 * `dragging`. Disabled zones ignore drops.
 */
export function useDropZone(onDrop: (picked: PickedItems) => void, enabled = true) {
  const [dragging, setDragging] = useState(false)
  if (!enabled) return { dragging: false, props: {} }

  const props = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation() // an inner zone (a fork branch) takes the drop, not the page behind it
      setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      setDragging(false)
      // readDrop must start during the event (the browser clears the dropped items after it).
      void readDrop(e.dataTransfer).then(onDrop)
    },
  }
  return { dragging, props }
}
