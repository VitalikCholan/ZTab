import { useCopiedToast } from './Toast.tsx';

export function ShareButton({
  title,
  text,
  url,
  label = 'Share',
  onDone,
}: {
  title: string;
  text: string;
  url: string;
  /** Accessible name, so rows can be told apart. */
  label?: string;
  onDone?: () => void;
}) {
  const { toast, show } = useCopiedToast();
  const share = async () => {
    const data = { title, text, url };
    if (typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        onDone?.();
      } catch {
        // The share sheet was dismissed: nothing was shared.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    show();
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
