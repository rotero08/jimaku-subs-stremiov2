// A small leveled logger. API keys travel inside URLs (that is how Stremio carries settings), so
// paths are redacted before they are ever written.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * "/eyJqaW1ha3U.../manifest.json" -> "/<config>/manifest.json". Any long first segment is taken
 * for settings (a real route name is short), so a mistyped address cannot leak a key either.
 */
export function redactPath(path) {
  return String(path).replace(/^\/[A-Za-z0-9_\-+=%]{16,}(?=\/|$)/, '/<config>');
}

export function createLogger({ level = 'info', format = 'json', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(name, message, fields = {}) {
    if (LEVELS[name] < threshold) return;
    const entry = { time: new Date().toISOString(), level: name, msg: message, ...fields };
    if (format === 'json') {
      stream.write(`${JSON.stringify(entry)}\n`);
      return;
    }
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    stream.write(`${entry.time.slice(11, 19)} ${name.toUpperCase().padEnd(5)} ${message}${extra ? `  ${extra}` : ''}\n`);
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger = createLogger({ level: 'silent' });
