'use strict';

/**
 * @file src/services/log.service.js
 *
 * Business logic for LogEntry creation, retrieval, and export.
 *
 * Dependency map:
 *   Database access     → log.repository  (lock + hash + transaction live there)
 *   Redis cache         → redis.service   (read cache only — never on write path)
 *   Async verification  → queue.service   (enqueues after commit)
 *
 * Write path (createLogEntry):
 *   PostgreSQL is the sole authority. Redis is updated AFTER the transaction
 *   commits and must never influence hash computation.
 *
 * Read path (getLogById):
 *   Cache-aside: Redis → hit → return | miss → DB → cache → return.
 *
 * Cache keys:
 *   latest_log  — { id, currentHash, createdAt } summary, read endpoints only
 *   log:{id}    — full LogEntry object, TTL = CACHE_TTL_SECONDS
 *
 * @module services/log
 */

const repository = require('../repositories/log.repository');
const hashService = require('./hash.service');
const redisService = require('./redis.service');
const queueService = require('./queue.service');
const { AppError } = require('../errors/AppError');
const { logger } = require('../lib/logger');

/** Redis key for the latest log entry summary (read path only). */
const LATEST_LOG_KEY = 'latest_log';

/**
 * Build the Redis key for a log entry by ID.
 *
 * @param {string} id
 * @returns {string}
 */
const logKey = (id) => `log:${id}`;

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a new LogEntry and link it to the hash chain.
 *
 * Workflow:
 *   1. Delegate entirely to the repository transaction:
 *        - Acquire ChainHead row lock (SELECT ... FOR UPDATE)
 *        - Read latestHash from PostgreSQL (inside the lock)
 *        - Compute previousHash + currentHash (inside the lock)
 *        - INSERT LogEntry
 *        - UPDATE ChainHead
 *        - COMMIT
 *   2. After commit: update Redis latest_log cache (non-fatal).
 *   3. After commit: enqueue async verification job (non-fatal).
 *   4. Return the saved record.
 *
 * Redis is never consulted during step 1. A Redis failure cannot cause stale
 * previousHash values. A transaction rollback never touches Redis.
 *
 * @param {{ actor: string, action: string, payload?: object|null }} dto
 * @returns {Promise<object>}
 */
async function createLogEntry(dto) {
  const { actor, action, payload = null } = dto;
  const createdAt = new Date();

  // ── Step 1: Transactional insert (lock → hash → insert → update) ────────
  const entry = await repository.createWithTransaction({ actor, action, payload, createdAt });

  // ── Step 2: Update Redis latest_log cache (post-commit, non-fatal) ───────
  await redisService.set(LATEST_LOG_KEY, {
    id: entry.id,
    currentHash: entry.currentHash,
    createdAt: entry.createdAt,
  });

  // ── Step 3: Enqueue async chain verification (non-fatal) ─────────────────
  await queueService.enqueueVerification(entry.id);

  return entry;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Retrieve a single LogEntry by UUID with cache-aside pattern.
 *
 * Flow: Redis → cache hit → return
 *              → cache miss → DB → store in Redis → return
 *
 * @param {string} id
 * @returns {Promise<{ entry: object, verificationStatus: boolean }>}
 * @throws {AppError} 404 if the entry does not exist.
 */
async function getLogById(id) {
  const cacheKey = logKey(id);

  const cached = await redisService.get(cacheKey);
  if (cached) {
    const resolvedPreviousHash = cached.previousHash ?? hashService.GENESIS_PREVIOUS_HASH;
    const verificationStatus = hashService.verifyEntry(cached, resolvedPreviousHash);
    return { entry: cached, verificationStatus };
  }

  const entry = await repository.findById(id);
  if (!entry) {
    throw new AppError('Log entry not found', 404, 'NOT_FOUND');
  }

  await redisService.set(cacheKey, entry);

  const resolvedPreviousHash = entry.previousHash ?? hashService.GENESIS_PREVIOUS_HASH;
  const verificationStatus = hashService.verifyEntry(entry, resolvedPreviousHash);

  return { entry, verificationStatus };
}

/**
 * Retrieve a single LogEntry by UUID (no verification enrichment).
 *
 * @param {string} id
 * @returns {Promise<object>}
 * @throws {AppError} 404 if not found.
 */
async function getLogEntryById(id) {
  const { entry } = await getLogById(id);
  return entry;
}

/**
 * Return a paginated list of log entries ordered by createdAt ASC.
 *
 * @param {number} [page=1]
 * @param {number} [pageSize=20]
 * @returns {Promise<{ data: object[], meta: { page: number, pageSize: number, total: number } }>}
 */
async function getAllLogEntries(page = 1, pageSize = 20) {
  const [data, total] = await Promise.all([
    repository.findAll(page, pageSize),
    repository.count(),
  ]);
  return { data, meta: { page, pageSize, total } };
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Export log entries with optional filtering.
 *
 * @param {{ actor?: string, from?: Date|string, to?: Date|string }} [filters]
 * @returns {Promise<object[]>}
 */
async function exportLogs(filters = {}) {
  return repository.findFiltered(filters);
}

module.exports = {
  createLogEntry,
  getLogById,
  getLogEntryById,
  getAllLogEntries,
  exportLogs,
};
