import { useCopiedToast } from './Toast.tsx';

export function CopyButton({
  text,
  label = 'Copy',
  failText,
  onDone,
  variant = 'primary',
}: {
  text: string;
  label?: string;
  failText?: string;
  onDone?: () => void;
  variant?: 'primary' | 'secondary';
}) {
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
      <button type="button" onClick={copy} aria-label={label} className={variant === 'primary' ? 'btn-primary' : 'btn-secondary'}>
        {label}
      </button>
      {toast}
    </span>
  );
}
