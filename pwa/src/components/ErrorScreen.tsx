import type { ReactNode } from 'react';

export function ErrorScreen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6 font-sans">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children && <p className="text-neutral-600">{children}</p>}
    </main>
  );
}
