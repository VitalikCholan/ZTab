import { createBrowserRouter } from 'react-router';
import { Landing } from './pages/Landing.tsx';
import { NewTab } from './pages/NewTab.tsx';
import { Links } from './pages/Links.tsx';
import { TabEntry } from './pages/TabEntry.tsx';

export const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/new', element: <NewTab /> },
  { path: '/new/links', element: <Links /> },
  { path: '/t/:tabId', element: <TabEntry /> },
]);
