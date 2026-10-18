import { useEffect, useState } from 'react';

const POLL_MS = 10_000;
const BOOST_POLL_MS = 5_000;
const BOOST_DURATION_MS = 10 * 60_000;

/** Poll faster for 10 minutes after someone starts paying. */
export function usePayBoost(): [intervalMs: number, boost: () => void] {
  const [boostedAt, setBoostedAt] = useState<number | null>(null);
  useEffect(() => {
    if (boostedAt === null) return;
    const t = setTimeout(() => setBoostedAt(null), BOOST_DURATION_MS);
    return () => clearTimeout(t);
  }, [boostedAt]);
  return [boostedAt === null ? POLL_MS : BOOST_POLL_MS, () => setBoostedAt(Date.now())];
}
