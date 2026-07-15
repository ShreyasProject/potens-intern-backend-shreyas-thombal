'use strict';

/**
 * @file src/workers/verification.worker.js
 *
 * BullMQ worker that processes hash-chain verification jobs asynchronously.
 *
 * Each job:
 *   1. Receives { logEntryId } from the queue.
 *   2. Calls verification.service.verifyIntegrity() — no duplicated logic.
 *   3. Logs the result (success or failure).
 *
 * Retry policy is defined on the queue (3 attempts, exponential back-off).
 * The worker never touches Redis directly or modifies the database.
 *
 * @module workers/verification
 */

const { Worker } = require('bullmq');
const { getClient } = require('../services/redis.service');
const { verifyIntegrity } = require('../services/verification.service');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');

/** @type {Worker | null} */
let worker = null;

/**
 * Start the verification worker.
 * Safe to call multiple times — returns existing worker if already started.
 *
 * @returns {Worker}
 */
function startVerificationWorker() {
  if (worker) return worker;

  worker = new Worker(
    'verification',
    async (job) => {
      const { logEntryId } = job.data;
      logger.info({ jobId: job.id, logEntryId }, 'Verification job started');

      const result = await verifyIntegrity();

      if (result.success) {
        logger.info(
          { jobId: job.id, logEntryId, totalEntries: result.totalEntries },
          'Queue job completed — chain intact'
        );
      } else {
        logger.warn(
          {
            jobId: job.id,
            logEntryId,
            brokenEntryId: result.brokenEntryId,
            reason: result.reason,
          },
          'Queue job completed — chain integrity failure detected'
        );
      }

      return result;
    },
    {
      connection: getClient(),
      concurrency: config.queueConcurrency,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Queue job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Queue job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Verification worker error');
  });

  logger.info({ concurrency: config.queueConcurrency }, 'Verification worker started');
  return worker;
}

/**
 * Gracefully stop the worker.
 *
 * @returns {Promise<void>}
 */
async function stopVerificationWorker() {
  if (!worker) return;
  try {
    await worker.close();
    logger.info('Verification worker stopped');
  } catch (err) {
    logger.error({ err }, 'Error stopping verification worker');
  } finally {
    worker = null;
  }
}

module.exports = { startVerificationWorker, stopVerificationWorker };
