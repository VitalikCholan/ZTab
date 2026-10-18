export function StaleBanner() {
  return (
    <p role="status" className="rounded bg-amber-100 px-3 py-2 text-sm text-amber-900">
      Live data is delayed; showing the last known status.
    </p>
  );
}
