// api/lib/logger.js
// 依存ゼロの構造化ロガー。Vercel Serverless ログ向けに 1 行 1 JSON で出力する。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevelThreshold() {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[env] ?? LEVELS.info;
}

function serializeError(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  if (typeof err === 'object') {
    // Error-like (e.g. Supabase error: { message, code, details, hint })
    return { ...err };
  }
  return { message: String(err) };
}

function emit(level, msg, ctx = {}) {
  if (LEVELS[level] < currentLevelThreshold()) return;

  const entry = { ts: new Date().toISOString(), level, msg };

  // err は特別扱い（Error オブジェクトを安全にシリアライズ）
  if (ctx && 'err' in ctx) {
    const { err, ...rest } = ctx;
    entry.err = serializeError(err);
    Object.assign(entry, rest);
  } else if (ctx && typeof ctx === 'object') {
    Object.assign(entry, ctx);
  }

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
};
