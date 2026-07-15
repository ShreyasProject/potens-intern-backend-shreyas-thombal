'use strict';

/**
 * @file src/services/queue.service.js
 *
 * Queue service — thin facade over the BullMQ verification queue.
 *
 * Responsibilities:
 *   - Add verification jobs after a log entry is committed.
 *   - Never block the HTTP response — queue failures are logged but do NOT
 *     roll back the committed database transaction.
 *
 * @module services/queue
 */

const { getVerificationQueue } = require('../queues/verification.queue');
const { logger } = require('../lib/logger');

/**
 * Add a verification job for the given log entry ID.
 *
 * Called after:
 *   1. Transaction committed
 *   2. Redis cache updated
 *
 * Failure is non-fatal: the log entry is already persisted in PostgreSQL.
 *
 * @param {string} logEntryId - UUID of the newly created log entry.
 * @returns {Promise<void>}
 */
async function enqueueVerification(logEntryId) {
  try {
    const queue = getVerificationQueue();
    const job = await queue.add(
      'verify-chain',
      { logEntryId },
      { jobId: `verify-${logEntryId}` }
    );
    logger.info({ jobId: job.id, logEntryId }, 'Queue job added');
  } catch (err) {
    logger.error({ err, logEntryId }, 'Failed to enqueue verification job — continuing');
  }
}

module.exports = { enqueueVerification };
