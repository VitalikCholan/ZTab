import { useEffect, useRef, useState, type ReactNode } from 'react';

export const MANUAL_COPY_MESSAGE = 'Copy failed — select the link above and copy it manually';

/** A short-lived `Copied` message, or a lasting failure message: render `toast` next to the button. */
export function useCopiedToast(failText = MANUAL_COPY_MESSAGE): { toast: ReactNode; show: () => void; fail: () => void } {
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = () => {
    setMsg({ text: 'Copied', ok: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2000);
  };
  const fail = () => {
    clearTimeout(timer.current);
    setMsg({ text: failText, ok: false });
  };
  const toast: ReactNode = (
    <span role="status" className={`text-sm ${msg?.ok === false ? 'text-red-700' : 'text-green-700'}`}>
      {msg?.text ?? ''}
    </span>
  );
  return { toast, show, fail };
}
