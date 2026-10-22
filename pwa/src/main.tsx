// Must stay first: configures zod before any module that uses it is evaluated.
import './zod-config.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.tsx';
import { ensureWasm } from './wasm.ts';

ensureWasm().catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
