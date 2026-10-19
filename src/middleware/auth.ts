/**
 * Control-plane middleware.
 *
 * Public read routes are intentionally unauthenticated. Privileged operations
 * (price commit, circuit-breaker reset) must require a shared secret and are
 * rate-limited per client IP.
 *
 * If CONTROLLER_ADMIN_API_KEY is not configured, control routes return 503
 * instead of falling open.
 */
import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

interface WindowState {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowState>();
const WINDOW_MS = 60_000;

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function extractApiKey(req: Request): string {
  const headerKey = req.header('x-api-key');
  if (headerKey) return headerKey;

  const authorization = req.header('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : '';
}

/**
 * Fixed-window per-IP rate limiter for control routes.
 * Kept dependency-free so the controller does not need another package.
 */
export function controlRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const now = Date.now();
  const key = clientKey(req);
  const window = windows.get(key);

  if (!window || now >= window.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  window.count += 1;
  if (window.count > config.controlRateLimitPerMinute) {
    const retryAfter = Math.ceil((window.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn('Control route rate limit exceeded', {
      ip: key,
      path: req.path,
    });
    res.status(429).json({ error: 'Too many control requests' });
    return;
  }

  next();
}

/**
 * Shared-secret authentication for privileged controller operations.
 */
export function requireControlAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!config.controlApiKey) {
    res.status(503).json({
      error:
        'Control API disabled: CONTROLLER_ADMIN_API_KEY is not configured',
    });
    return;
  }

  const provided = extractApiKey(req);
  if (!provided || !constantTimeEquals(provided, config.controlApiKey)) {
    logger.warn('Unauthorized control request', {
      ip: clientKey(req),
      method: req.method,
      path: req.path,
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

/**
 * Test helper: clear the in-memory rate-limit state.
 */
export function resetControlRateLimitForTests(): void {
  windows.clear();
}
