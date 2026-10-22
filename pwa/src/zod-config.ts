import { z } from 'zod';

// Zod probes `new Function` to choose its JIT parser; under our CSP (no 'unsafe-eval') that probe is a violation.
z.config({ jitless: true });
