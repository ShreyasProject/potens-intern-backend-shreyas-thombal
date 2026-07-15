'use strict';

/**
 * @file src/config/env.js
 *
 * Environment configuration — MUST be the first module loaded by the application.
 *
 * Loads .env via dotenv, then validates every required variable with Zod.
 * On failure it writes a human-readable message to stderr and exits with code 1,
 * so the application never starts in a misconfigured state.
 *
 * @module config/env
 */

const dotenv = require('dotenv');
const { z } = require('zod');

// ── 1. Load .env into process.env ────────────────────────────────────────────
dotenv.config();

// ── 2. Zod schema ─────────────────────────────────────────────────────────────

const envSchema = z.object({
  PORT: z.coerce
    .number()
    .int('PORT must be an integer')
    .min(1, 'PORT must be at least 1')
    .max(65535, 'PORT must be at most 65535'),

  NODE_ENV: z.enum(['development', 'test', 'production'], {
    errorMap: () => ({ message: 'NODE_ENV must be one of: development, test, production' }),
  }),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL must be a non-empty string'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], {
      errorMap: () => ({
        message: 'LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal',
      }),
    })
    .default('info'),

  RATE_LIMIT_MAX: z.coerce
    .number()
    .int('RATE_LIMIT_MAX must be an integer')
    .positive('RATE_LIMIT_MAX must be a positive integer')
    .default(100),

  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int('RATE_LIMIT_WINDOW_MS must be an integer')
    .positive('RATE_LIMIT_WINDOW_MS must be a positive integer')
    .default(60000),

  API_KEY: z.string().min(1, 'API_KEY must be a non-empty string'),

  CORS_ORIGIN: z.string().default('*'),

  /** Redis connection URL used by ioredis, BullMQ, and the cache service. */
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL').default('redis://localhost:6379'),

  /** Number of concurrent BullMQ worker threads processing the verification queue. */
  QUEUE_CONCURRENCY: z.coerce
    .number()
    .int('QUEUE_CONCURRENCY must be an integer')
    .positive('QUEUE_CONCURRENCY must be a positive integer')
    .default(2),

  /**
   * Redis cache TTL in seconds.
   * Must be at least 1 — a value of 0 disables expiry entirely in Redis,
   * which would turn the cache into persistent storage and violate the
   * cache-aside pattern.
   */
  CACHE_TTL_SECONDS: z.coerce
    .number()
    .int('CACHE_TTL_SECONDS must be an integer')
    .min(1, 'CACHE_TTL_SECONDS must be at least 1 second (0 would disable expiry)')
    .default(600),
});

// ── 3. Parse & validate ───────────────────────────────────────────────────────

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.errors
    .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n');

  process.stderr.write(`[CONFIG] Validation failed:\n${lines}\n`);
  process.exit(1);
}

// ── 4. Frozen config export ───────────────────────────────────────────────────

const raw = parsed.data;

/**
 * Validated, frozen application configuration.
 *
 * Never read process.env directly in application code — import this object.
 *
 * @type {Readonly<{
 *   port: number,
 *   nodeEnv: 'development'|'test'|'production',
 *   databaseUrl: string,
 *   logLevel: 'trace'|'debug'|'info'|'warn'|'error'|'fatal',
 *   rateLimitMax: number,
 *   rateLimitWindowMs: number,
 *   apiKey: string,
 *   corsOrigin: string,
 *   redisUrl: string,
 *   queueConcurrency: number,
 *   cacheTtlSeconds: number
 * }>}
 */
const config = Object.freeze({
  port: raw.PORT,
  nodeEnv: raw.NODE_ENV,
  databaseUrl: raw.DATABASE_URL,
  logLevel: raw.LOG_LEVEL,
  rateLimitMax: raw.RATE_LIMIT_MAX,
  rateLimitWindowMs: raw.RATE_LIMIT_WINDOW_MS,
  apiKey: raw.API_KEY,
  corsOrigin: raw.CORS_ORIGIN,
  redisUrl: raw.REDIS_URL,
  queueConcurrency: raw.QUEUE_CONCURRENCY,
  cacheTtlSeconds: raw.CACHE_TTL_SECONDS,
});

module.exports = { config };
