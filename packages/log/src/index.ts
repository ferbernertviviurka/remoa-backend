export type Level = 'info' | 'warn' | 'error';
export type Logger = Record<Level, (msg: string, extra?: Record<string, unknown>) => void>;

const order: Record<Level, number> = { info: 0, warn: 1, error: 2 };

export const newRequestId = () => crypto.randomUUID();

/** One JSON line per call: stdout for info, stderr for warn/error. Threshold from LOG_LEVEL (default info). */
export function createLogger({ requestId }: { requestId: string }): Logger {
  const min = order[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? 0;
  const make = (level: Level): Logger[Level] => (msg, extra) => {
    if (order[level] < min) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), requestId, msg, ...extra }) + '\n';
    (level === 'info' ? process.stdout : process.stderr).write(line);
  };
  return { info: make('info'), warn: make('warn'), error: make('error') };
}
