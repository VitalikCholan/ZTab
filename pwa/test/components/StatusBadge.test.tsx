import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBadge } from '../../src/components/StatusBadge.tsx';
import { BADGE_LABEL, type Badge } from '../../src/domain/status.ts';

afterEach(cleanup);

describe('StatusBadge', () => {
  it('renders the existing label for every badge', () => {
    for (const badge of Object.keys(BADGE_LABEL) as Badge[]) {
      const { unmount } = render(<StatusBadge badge={badge} />);
      expect(screen.getByText(BADGE_LABEL[badge]).textContent).toBe(BADGE_LABEL[badge]);
      unmount();
    }
  });

  it('seen pulses only when motion is allowed', () => {
    render(<StatusBadge badge="seen" />);
    expect(screen.getByText(BADGE_LABEL.seen).querySelector('[aria-hidden="true"]')?.classList.contains('motion-safe:animate-pulse')).toBe(true);
    cleanup();
    render(<StatusBadge badge="paid" />);
    expect(screen.getByText(BADGE_LABEL.paid).querySelector('[aria-hidden="true"]')?.classList.contains('motion-safe:animate-pulse')).toBe(false);
  });

  it('paid uses the ok tone, waiting the accent tone', () => {
    render(<StatusBadge badge="paid" />);
    expect(screen.getByText(BADGE_LABEL.paid).classList.contains('text-ok')).toBe(true);
    cleanup();
    render(<StatusBadge badge="waiting" />);
    expect(screen.getByText(BADGE_LABEL.waiting).classList.contains('text-accent')).toBe(true);
  });
});
