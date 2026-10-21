import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';

export function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Rendering failure leaves the canvas blank; the copy buttons remain the fallback.
    QRCode.toCanvas(canvas, text, { width: size, margin: 1 }).catch(() => undefined);
  }, [text, size]);
  return <canvas ref={ref} role="img" aria-label="QR code for payment" width={size} height={size} className="rounded bg-white" />;
}
