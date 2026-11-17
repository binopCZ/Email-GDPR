import cron from 'node-cron';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { brokers, removalRequests, requestLogs, users } from '../db/schema.ts';
import { unwrapUserDek } from '../db/users.ts';
import { encryptWithKey } from '../security/crypto.ts';

export interface SchedulerSweepSummary {
  escalatedCount: number;
  requeuedCount: number;
  checkedAt: string;
}

export async function runComplianceSchedulerSweep(
  filterUserId?: string
): Promise<SchedulerSweepSummary> {
  const now = new Date();
  let escalatedCount = 0;
  let requeuedCount = 0;

  try {
    // 1. Detect expired 30-day statutory deadlines (GDPR Art. 12(3) / CCPA)
    const slaConditions = [
      inArray(removalRequests.status, ['SENT', 'IN_REVIEW']),
      lte(removalRequests.deadlineAt, now),
    ];
    if (filterUserId) {
      slaConditions.push(eq(removalRequests.userId, filterUserId));
    }

    const overdueRequests = await db
      .select({
        request: removalRequests,
        user: users,
        brokerName: brokers.name,
      })
      .from(removalRequests)
      .innerJoin(users, eq(removalRequests.userId, users.id))
      .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
      .where(and(...slaConditions));

    for (const row of overdueRequests) {
      await db
        .update(removalRequests)
        .set({
          status: 'ESCALATED',
          actionReasonCode: 'SLA_30D_EXPIRED',
          actionReasonDetail: `30-day statutory deadline expired without confirmation from ${row.brokerName}.`,
          updatedAt: now,
        })
        .where(eq(removalRequests.id, row.request.id));

      const dek = unwrapUserDek(row.user);
      const encryptedPayload = encryptWithKey(
        `Scheduler escalated request ${row.request.id} for ${row.brokerName}: 30-day SLA expired at ${row.request.deadlineAt?.toISOString()}.`,
        dek,
        `request_logs:${row.user.id}:${row.request.id}`
      );

      await db.insert(requestLogs).values({
        requestId: row.request.id,
        userId: row.user.id,
        direction: 'SYSTEM',
        channel: 'SCHEDULER',
        eventType: 'SLA_EXPIRED_30D',
        payloadEnc: encryptedPayload.ciphertext,
        payloadIv: encryptedPayload.iv,
        payloadTag: encryptedPayload.authTag,
        httpStatus: 408,
      });
      escalatedCount += 1;
    }

    // 2. Trigger 60-90 day re-check cycles for previously DELETED requests
    const recheckConditions = [
      eq(removalRequests.status, 'DELETED'),
      lte(removalRequests.nextCycleAt, now),
    ];
    if (filterUserId) {
      recheckConditions.push(eq(removalRequests.userId, filterUserId));
    }

    const dueRechecks = await db
      .select({
        request: removalRequests,
        user: users,
        broker: brokers,
      })
      .from(removalRequests)
      .innerJoin(users, eq(removalRequests.userId, users.id))
      .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
      .where(and(...recheckConditions));

    for (const row of dueRechecks) {
      const nextCycle = row.request.cycleNumber + 1;
      const newDeadline = new Date(now.getTime() + row.broker.legalSlaDays * 86400_000);

      await db
        .update(removalRequests)
        .set({
          status: 'SENT',
          cycleNumber: nextCycle,
          sentAt: now,
          deadlineAt: newDeadline,
          nextCycleAt: null,
          updatedAt: now,
        })
        .where(eq(removalRequests.id, row.request.id));

      const dek = unwrapUserDek(row.user);
      const encryptedPayload = encryptWithKey(
        `Cycle #${nextCycle} automated re-verification erasure request sent to ${row.broker.name} after ${row.broker.recheckIntervalDays}-day interval.`,
        dek,
        `request_logs:${row.user.id}:${row.request.id}`
      );

      await db.insert(requestLogs).values({
        requestId: row.request.id,
        userId: row.user.id,
        direction: 'OUTBOUND',
        channel: 'SCHEDULER',
        eventType: 'CYCLE_RECHECK_DISPATCHED',
        payloadEnc: encryptedPayload.ciphertext,
        payloadIv: encryptedPayload.iv,
        payloadTag: encryptedPayload.authTag,
        httpStatus: 202,
      });
      requeuedCount += 1;
    }

    return {
      escalatedCount,
      requeuedCount,
      checkedAt: now.toISOString(),
    };
  } catch (error) {
    console.error('Compliance scheduler sweep failed:', error);
    throw new Error('Compliance scheduler sweep failed.', { cause: error });
  }
}

import { processPendingAutomationJobs } from './workerQueue.ts';

let schedulerTask: ReturnType<typeof cron.schedule> | null = null;
let workerTask: ReturnType<typeof cron.schedule> | null = null;

export function startComplianceScheduler() {
  if (!schedulerTask) {
    // Runs every hour at minute 0 to enforce 30-day SLA deadlines & 60-90 day re-cycles
    schedulerTask = cron.schedule('0 * * * *', () => {
      void runComplianceSchedulerSweep().catch((err) => {
        console.error('Scheduled compliance sweep error:', err);
      });
    });
  }

  if (!workerTask) {
    // Runs every minute to retry backoff automation_jobs
    workerTask = cron.schedule('* * * * *', () => {
      void processPendingAutomationJobs().catch((err) => {
        console.error('Background worker queue tick error:', err);
      });
    });
  }
}
