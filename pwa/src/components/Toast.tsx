import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A short-lived `Copied` message: `show()` it, render `toast` next to the button. */
export function useCopiedToast(): { toast: ReactNode; show: () => void } {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = () => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 2000);
  };
  const toast = (
    <span role="status" className="text-sm text-green-700">
      {visible ? 'Copied' : ''}
    </span>
  );
  return { toast, show };
}
