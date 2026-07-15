'use strict';

/**
 * @file src/queues/verification.queue.js
 *
 * BullMQ queue definition for asynchronous hash-chain verification.
 *
 * The queue is created once and reused across the application.
 * Workers consume jobs from this queue without blocking HTTP responses.
 *
 * @module queues/verification
 */

const { Queue } = require('bullmq');
const { getClient } = require('../services/redis.service');
const { logger } = require('../lib/logger');

/** @type {Queue | null} */
let verificationQueue = null;

/**
 * Return the singleton BullMQ verification queue.
 * Creates it on first call; subsequent calls return the same instance.
 *
 * @returns {Queue}
 */
function getVerificationQueue() {
  if (verificationQueue) return verificationQueue;

  verificationQueue = new Queue('verification', {
    connection: getClient(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1_000, // 1 s → 2 s → 4 s
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });

  verificationQueue.on('error', (err) => {
    logger.error({ err }, 'Verification queue error');
  });

  logger.info('Verification queue initialised');
  return verificationQueue;
}

/**
 * Close the queue connection gracefully.
 *
 * @returns {Promise<void>}
 */
async function closeVerificationQueue() {
  if (!verificationQueue) return;
  try {
    await verificationQueue.close();
    logger.info('Verification queue closed');
  } catch (err) {
    logger.error({ err }, 'Error closing verification queue');
  } finally {
    verificationQueue = null;
  }
}

module.exports = { getVerificationQueue, closeVerificationQueue };
