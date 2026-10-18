import { useCopiedToast } from './Toast.tsx';

export function CopyButton({ text, label = 'Copy', failText, onDone }: { text: string; label?: string; failText?: string; onDone?: () => void }) {
  const { toast, show, fail } = useCopiedToast(failText);
  const copy = async () => {
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
      <button type="button" onClick={copy} aria-label={label} className="rounded bg-neutral-900 px-4 py-3 font-medium text-white">
        {label}
      </button>
      {toast}
    </span>
  );
}
