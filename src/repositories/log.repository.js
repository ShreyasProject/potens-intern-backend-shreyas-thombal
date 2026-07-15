'use strict';

/**
 * @file src/repositories/log.repository.js
 *
 * Data-access layer for LogEntry and ChainHead records.
 *
 * Responsibilities:
 *   - All Prisma queries live here and NOWHERE else.
 *   - No business logic, no Redis, no BullMQ.
 *   - Transaction boundaries (including the row-level lock) are owned here.
 *   - Hash computation happens inside the transaction after the lock is acquired.
 *
 * Exported API:
 *   findById(id)
 *   findLatest()
 *   findAll(page, pageSize)
 *   findAllOrdered()
 *   findFiltered(filters)
 *   count()
 *   createWithTransaction(dto) — lock → read hash → compute → insert → update
 *
 * @module repositories/log
 */

const { prisma } = require('../config/database');
const hashService = require('../services/hash.service');
const { logger } = require('../lib/logger');

// ── Single-record reads ───────────────────────────────────────────────────────

/**
 * Find a single LogEntry by UUID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  return prisma.logEntry.findUnique({ where: { id } });
}

/**
 * Return the most recently inserted LogEntry (createdAt DESC).
 *
 * @returns {Promise<object|null>}
 */
async function findLatest() {
  return prisma.logEntry.findFirst({ orderBy: { createdAt: 'desc' } });
}

/**
 * Return the entry immediately before the given createdAt timestamp.
 *
 * @param {Date} createdAt
 * @returns {Promise<object|null>}
 */
async function findPrevious(createdAt) {
  return prisma.logEntry.findFirst({
    where: { createdAt: { lt: createdAt } },
    orderBy: { createdAt: 'desc' },
  });
}

// ── List reads ────────────────────────────────────────────────────────────────

/**
 * Return a paginated list of LogEntry records ordered by createdAt ASC.
 *
 * @param {number} page
 * @param {number} pageSize
 * @returns {Promise<object[]>}
 */
async function findAll(page, pageSize) {
  return prisma.logEntry.findMany({
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Return ALL records ordered by createdAt ASC (no pagination).
 *
 * @returns {Promise<object[]>}
 */
async function findAllOrdered() {
  return prisma.logEntry.findMany({ orderBy: { createdAt: 'asc' } });
}

/**
 * Return filtered records for export, ordered by createdAt ASC.
 *
 * @param {{ actor?: string, from?: Date|string, to?: Date|string }} [filters]
 * @returns {Promise<object[]>}
 */
async function findFiltered(filters = {}) {
  /** @type {import('@prisma/client').Prisma.LogEntryWhereInput} */
  const where = {};

  if (filters.actor) {
    where.actor = filters.actor;
  }

  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  return prisma.logEntry.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Return the total count of LogEntry records.
 *
 * @returns {Promise<number>}
 */
async function count() {
  return prisma.logEntry.count();
}

// ── Transactional write with row-level lock ───────────────────────────────────

/**
 * Create a new LogEntry inside a serialised PostgreSQL transaction.
 *
 * The entire critical section executes atomically while ChainHead is locked:
 *   BEGIN
 *   → SELECT ... FOR UPDATE on chain_head (blocks concurrent writers)
 *   → Read latestHash from the locked row
 *   → Compute previousHash + currentHash via hash.service
 *   → INSERT LogEntry
 *   → UPDATE ChainHead
 *   COMMIT
 *
 * Redis is never consulted here. PostgreSQL is the sole authority for the
 * hash chain. Two concurrent requests cannot share the same previousHash
 * because the second waits at the FOR UPDATE until the first commits.
 *
 * The raw SQL SELECT ... FOR UPDATE is the only permitted raw query in this
 * codebase; Prisma does not expose row-level locking natively.
 *
 * @param {{
 *   actor: string,
 *   action: string,
 *   payload?: object|null,
 *   createdAt: Date
 * }} dto - Raw entry data. Hashes are computed inside the transaction.
 * @returns {Promise<object>} The persisted LogEntry.
 */
async function createWithTransaction(dto) {
  const { actor, action, payload = null, createdAt } = dto;

  logger.debug('Transaction started');

  try {
    const entry = await prisma.$transaction(async (tx) => {
      // ── Step 1: Acquire exclusive row lock ───────────────────────────────
      const chainHeads = await tx.$queryRaw`
        SELECT id, "latestHash" FROM chain_head WHERE id = 1 FOR UPDATE
      `;
      const chainHead = chainHeads[0];

      // ── Step 2: Compute hashes from the locked ChainHead state ───────────
      let previousHash;
      let currentHash;

      if (chainHead.latestHash === hashService.GENESIS_PREVIOUS_HASH) {
        previousHash = hashService.GENESIS_PREVIOUS_HASH;
        currentHash = hashService.createGenesisHash(actor, action, payload, createdAt);
      } else {
        previousHash = chainHead.latestHash;
        currentHash = hashService.calculateCurrentHash(
          actor, action, payload, previousHash, createdAt
        );
      }

      // ── Step 3: Insert the new LogEntry ──────────────────────────────────
      const created = await tx.logEntry.create({
        data: { actor, action, payload, previousHash, currentHash, createdAt },
      });

      // ── Step 4: Update ChainHead ──────────────────────────────────────────
      await tx.chainHead.update({
        where: { id: 1 },
        data: { latestHash: currentHash, latestLogId: created.id },
      });

      return created;
    });

    logger.debug({ entryId: entry.id }, 'Transaction committed');
    return entry;
  } catch (err) {
    logger.error({ err }, 'Transaction rolled back');
    throw err;
  }
}

module.exports = {
  findById,
  findLatest,
  findPrevious,
  findAll,
  findAllOrdered,
  findFiltered,
  count,
  createWithTransaction,
};
