import { useCopiedToast } from './Toast.tsx';

export function ShareButton({
  title,
  text,
  url,
  label = 'Share',
  failText,
  onDone,
}: {
  title: string;
  text: string;
  url: string;
  /** Accessible name, so rows can be told apart. */
  label?: string;
  failText?: string;
  onDone?: () => void;
}) {
  const { toast, show, fail } = useCopiedToast(failText);
  const share = async () => {
    const data = { title, text, url };
    if (typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(data))) {
      try {
        await navigator.share(data);
      } catch (e) {
        // A dismissed share sheet shares nothing and needs no message; any other failure
        // must not strand the link.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        fail();
        onDone?.();
        return;
      }
      onDone?.();
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      show();
    } catch {
      fail();
    }
    onDone?.();
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={share} aria-label={label} className="rounded border border-neutral-900 px-4 py-3 font-medium">
        Share
      </button>
      {toast}
    </span>
  );
}
