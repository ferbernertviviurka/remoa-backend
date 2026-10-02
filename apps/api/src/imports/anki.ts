import * as real from '@remoa/anki';
import type { AnkiPort } from './imports';

/** Production parser port (packages/anki). Tests inject mocks instead. */
export const ankiPort: AnkiPort = { inspect: real.inspect, planImport: real.planImport, toDrafts: real.toDrafts, openPackage: real.openPackage, rootOf: real.rootOf };
