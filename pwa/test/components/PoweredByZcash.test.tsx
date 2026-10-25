import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PoweredByZcash } from '../../src/components/PoweredByZcash.tsx';

afterEach(cleanup);

describe('PoweredByZcash', () => {
  it('links to z.cash in a new tab with a safe rel', () => {
    render(<PoweredByZcash />);
    const link = screen.getByRole('link', { name: 'Powered by Zcash' });
    expect(link).toHaveAttribute('href', 'https://z.cash/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows the decorative brandmark at 16px', () => {
    const { container } = render(<PoweredByZcash />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/zcash-mark.svg');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', '16');
    expect(img).toHaveAttribute('height', '16');
  });
});
