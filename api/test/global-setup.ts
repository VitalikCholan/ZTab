import { execFileSync } from 'node:child_process';

// Jest loads this file outside the ESM test runtime, so it stays
// dependency-free (no relative imports). Runs once per jest run; jest is
// started from api/ by the package scripts.
export default function globalSetup(): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://ztab:ztab@localhost:55432/ztab_test',
    },
    stdio: 'inherit',
  });
}
