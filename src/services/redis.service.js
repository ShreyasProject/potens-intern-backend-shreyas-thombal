'use strict';

/**
 * @file src/services/redis.service.js
 *
 * Redis cache service — singleton ioredis client with automatic reconnect.
 *
 * This service is a cache-only layer. PostgreSQL remains the authoritative
 * source of truth. If Redis is unavailable the application continues using
 * the database without crashing.
 *
 * Public API:
 *   connect()    — Establish the connection (called once at startup).
 *   disconnect() — Graceful shutdown (called on SIGTERM/SIGINT).
 *   get(key)     — Return parsed JSON value or null on miss/error.
 *   set(key, value, ttlSeconds) — Serialise and store with TTL.
 *   del(key)     — Delete a key.
 *
 * @module services/redis
 */

const Redis = require('ioredis');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');

// ── Singleton ─────────────────────────────────────────────────────────────────

/** @type {Redis | null} */
let client = null;

/**
 * Build and return the ioredis singleton.
 * Subsequent calls return the same instance.
 *
 * @returns {Redis}
 */
function getClient() {
  if (client) return client;

  client = new Redis(config.redisUrl, {
    // Retry forever with exponential back-off, capped at 10 s
    retryStrategy(times) {
      const delay = Math.min(times * 200, 10_000);
      logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting');
      return delay;
    },
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  client.on('connect', () => logger.info('Redis connected'));
  client.on('ready', () => logger.info('Redis ready'));
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('close', () => logger.warn('Redis connection closed'));
  client.on('reconnecting', () => logger.warn('Redis reconnecting'));

  return client;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Explicitly open the Redis connection.
 * Safe to call multiple times — returns immediately if already connected.
 *
 * @returns {Promise<void>}
 */
async function connect() {
  try {
    await getClient().connect();
    logger.info('Redis service connected');
  } catch (err) {
    logger.error({ err }, 'Redis initial connection failed — continuing without cache');
  }
}

/**
 * Gracefully close the Redis connection.
 *
 * @returns {Promise<void>}
 */
async function disconnect() {
  if (!client) return;
  try {
    await client.quit();
    logger.info('Redis disconnected');
  } catch (err) {
    logger.error({ err }, 'Redis disconnect error');
  } finally {
    client = null;
  }
}

// ── Cache operations ──────────────────────────────────────────────────────────

/**
 * Retrieve and parse a cached value.
 *
 * @param {string} key
 * @returns {Promise<object|null>} Parsed object on cache hit, null on miss or error.
 */
async function get(key) {
  try {
    const raw = await getClient().get(key);
    if (raw === null) {
      logger.debug({ key }, 'Redis cache miss');
      return null;
    }
    logger.debug({ key }, 'Redis cache hit');
    return JSON.parse(raw);
  } catch (err) {
    logger.error({ err, key }, 'Redis get error — falling back to DB');
    return null;
  }
}

/**
 * Serialise and store a value with a TTL.
 *
 * @param {string} key
 * @param {object} value        - Must be JSON-serialisable.
 * @param {number} [ttlSeconds] - Defaults to config.cacheTtlSeconds. Must be >= 1.
 * @returns {Promise<void>}
 */
async function set(key, value, ttlSeconds = config.cacheTtlSeconds) {
  try {
    await getClient().setex(key, ttlSeconds, JSON.stringify(value));
    logger.debug({ key, ttlSeconds }, 'Redis cache set');
  } catch (err) {
    logger.error({ err, key }, 'Redis set error — cache write skipped');
  }
}

/**
 * Delete a key from Redis.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
async function del(key) {
  try {
    await getClient().del(key);
    logger.debug({ key }, 'Redis key deleted');
  } catch (err) {
    logger.error({ err, key }, 'Redis del error');
  }
}

module.exports = { connect, disconnect, get, set, del, getClient };
