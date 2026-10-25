export function StaleBanner() {
  return (
    <p role="status" className="rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
      Live data is delayed; showing the last known status.
    </p>
  );
}
