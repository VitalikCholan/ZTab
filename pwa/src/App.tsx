import { RouterProvider } from 'react-router';
import { router } from './routes.tsx';

// The crypto-module gate lives in TabEntry: only tab pages need wasm.
export function App() {
  return <RouterProvider router={router} />;
}
