import { createBrowserRouter } from 'react-router'
import { AppShell } from '@/app/AppShell'
import { ChatPage } from '@/features/chat/ChatPage'
import { GraphPage } from '@/features/graph/GraphPage'
import { OpenLastProject } from '@/features/projects/OpenLastProject'

// Each screen has its own URL, so the browser's back button and deep links work (in Electron too).
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <OpenLastProject /> },
      { path: 'projects/:projectId', element: <GraphPage /> },
      { path: 'projects/:projectId/nodes/:nodeId', element: <ChatPage /> },
    ],
  },
])
