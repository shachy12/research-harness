import { createBrowserRouter, Navigate } from 'react-router'
import { AppShell } from '@/app/AppShell'
import { ChatPage } from '@/features/chat/ChatPage'
import { GraphPage } from '@/features/graph/GraphPage'

// Each screen has its own URL, so the browser's back button and deep links work (in Electron too).
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      // Until the projects sidebar exists, everything lives in one default project.
      { index: true, element: <Navigate to="/projects/default" replace /> },
      { path: 'projects/:projectId', element: <GraphPage /> },
      { path: 'projects/:projectId/nodes/:nodeId', element: <ChatPage /> },
    ],
  },
])
