import { AsyncLocalStorage } from 'node:async_hooks';

/** User id for the current request, so the grader can log cost without a second argument. */
export const caller = new AsyncLocalStorage<string>();
