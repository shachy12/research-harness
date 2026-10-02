import { FileIcon, FolderIcon, PaperclipIcon } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { groupPickedFolder, type PickedFolder } from '@/lib/dropped-files'

// File types the file picker offers (dropping accepts anything).
const ACCEPT = '.pdf,.tex,.bib,.sty,.cls,.txt,.md,.csv,.json,.py,.png,.jpg,.jpeg,.gif,.webp'

/**
 * One paperclip button for files and folders. A web page can't open one dialog that picks both
 * (the browser's picker does files, or with `webkitdirectory` one folder), so it opens a small menu.
 */
export function AttachMenu({ onFiles, onFolders, disabled }: {
  onFiles: (files: File[]) => void
  onFolders: (folders: PickedFolder[]) => void
  disabled?: boolean
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files))
          e.target.value = '' // allow picking the same file again
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // Folder picker; React has no typed prop for this browser attribute.
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          if (e.target.files?.length) onFolders(groupPickedFolder(e.target.files))
          e.target.value = ''
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Attach files or a folder"
              title="Attach files or a folder — or drop them here"
            />
          }
        >
          <PaperclipIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuItem onClick={() => fileInput.current?.click()}>
            <FileIcon />
            <span className="flex flex-col">
              Files…
              <span className="text-xs text-muted-foreground">PDF, LaTeX, text, images</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => folderInput.current?.click()}>
            <FolderIcon />
            <span className="flex flex-col">
              Folder…
              <span className="text-xs text-muted-foreground">e.g. a LaTeX project</span>
            </span>
          </DropdownMenuItem>
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Or drop files and folders here.</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
