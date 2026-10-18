// Real cron timers must never run during e2e tests (see LifecycleModule).
process.env.ZTAB_DISABLE_CRON = '1';
