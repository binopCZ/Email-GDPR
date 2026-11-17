import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  aliasMailboxes,
  automationJobs,
  brokers,
  removalRequests,
  requestLogs,
  userPii,
  users,
} from '../db/schema.ts';
import { decryptUserEmail, unwrapUserDek } from '../db/users.ts';
import { decryptWithKey, encryptWithKey } from '../security/crypto.ts';
import { generateErasureNoticePdf } from './pdfGenerator.ts';
import { dispatchErasureSubmission } from './automation.ts';
import { sendErasureEmail } from './emailSender.ts';

export async function processPendingAutomationJobs(filterUserId?: string): Promise<number> {
  const now = new Date();
  const conditions = [
    inArray(automationJobs.status, ['QUEUED', 'RETRY_WAIT']),
    lte(automationJobs.nextRunAt, now),
  ];
  if (filterUserId) {
    conditions.push(eq(automationJobs.userId, filterUserId));
  }

  const pendingJobs = await db
    .select()
    .from(automationJobs)
    .where(and(...conditions))
    .limit(25);

  let processed = 0;

  for (const job of pendingJobs) {
    try {
      await db
        .update(automationJobs)
        .set({ status: 'RUNNING', updatedAt: new Date() })
        .where(eq(automationJobs.id, job.id));

      const rows = await db
        .select({
          request: removalRequests,
          user: users,
          broker: brokers,
          alias: aliasMailboxes,
        })
        .from(removalRequests)
        .innerJoin(users, eq(removalRequests.userId, users.id))
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .leftJoin(aliasMailboxes, eq(removalRequests.aliasId, aliasMailboxes.id))
        .where(eq(removalRequests.id, job.requestId))
        .limit(1);

      if (rows.length === 0) {
        await db
          .update(automationJobs)
          .set({ status: 'FAILED', lastError: 'Target request no longer exists', updatedAt: new Date() })
          .where(eq(automationJobs.id, job.id));
        continue;
      }

      const { request: reqRow, user: userRow, broker, alias } = rows[0];
      const dek = unwrapUserDek(userRow);
      const piiRows = await db
        .select()
        .from(userPii)
        .where(and(eq(userPii.userId, userRow.id), eq(userPii.isActive, true)));

      const decryptedIdentifiers = piiRows.map((p) => ({
        type: p.piiType,
        value: decryptWithKey(
          p.valueCiphertext,
          p.valueIv,
          p.valueAuthTag,
          dek,
          `user_pii:${userRow.id}:${p.piiType}`
        ),
      }));

      const fullName =
        decryptedIdentifiers.find((i) => i.type === 'FULL_NAME' || i.type === 'ALT_NAME')
          ?.value ?? decryptUserEmail(userRow);

      const aliasAddress = alias?.aliasAddress ?? 'relay@privavault.local';
      const pdfResult = await generateErasureNoticePdf({
        requestId: reqRow.id,
        legalBasis: reqRow.legalBasis,
        brokerName: broker.name,
        brokerDomain: broker.domain,
        dpoEmail: broker.dpoEmail,
        aliasEmail: aliasAddress,
        fullName,
        identifiers: decryptedIdentifiers,
        poaSignedAt: userRow.poaSignedAt,
        issuedAt: now,
      });

      const execResult = await dispatchErasureSubmission(
        {
          id: broker.id,
          slug: broker.slug,
          name: broker.name,
          domain: broker.domain,
          removalMethod: broker.removalMethod,
          dpoEmail: broker.dpoEmail,
          optOutUrl: broker.optOutUrl,
          brokerStatus: broker.brokerStatus,
          requiresIdCheck: broker.requiresIdCheck,
          automationConfig: broker.automationConfig,
        },
        aliasAddress,
        pdfResult.sha256
      );

      let emailSummary = execResult.detailLog;
      if (execResult.outcomeStatus === 'SENT' && broker.dpoEmail) {
        const emailResult = await sendErasureEmail({
          to: broker.dpoEmail,
          replyTo: aliasAddress,
          subject:
            broker.domain.endsWith('.cz') && reqRow.legalBasis === 'GDPR_ART_17'
              ? `Žádost o výmaz osobních údajů (čl. 17 GDPR) — Ref: ${reqRow.id.slice(0, 8)}`
              : `Formal Data Erasure Request (${reqRow.legalBasis}) — Ref: ${reqRow.id.slice(0, 8)}`,
          textBody: pdfResult.plainTextSummary,
          pdfBuffer: pdfResult.buffer,
          pdfFilename: `erasure-${broker.slug}-${reqRow.id.slice(0, 8)}.pdf`,
        });
        emailSummary = `${execResult.detailLog}\n${emailResult.detail}`;
      }

      const nextAttempts = job.attempts + 1;

      // Retry transient TIMEOUTs with exponential backoff before requiring manual intervention
      if (
        execResult.actionReasonCode === 'TIMEOUT' &&
        nextAttempts < job.maxAttempts
      ) {
        const backoffSeconds = Math.pow(2, nextAttempts) * 60;
        const retryAt = new Date(Date.now() + backoffSeconds * 1000);
        await db
          .update(automationJobs)
          .set({
            status: 'RETRY_WAIT',
            attempts: nextAttempts,
            nextRunAt: retryAt,
            lastError: execResult.actionReasonDetail,
            updatedAt: new Date(),
          })
          .where(eq(automationJobs.id, job.id));

        await db
          .update(removalRequests)
          .set({
            status: 'QUEUED',
            retryCount: nextAttempts,
            actionReasonCode: 'RETRY_SCHEDULED',
            actionReasonDetail: `Dočasný timeout — automatický pokus #${nextAttempts + 1} naplánován za ${backoffSeconds}s.`,
            updatedAt: new Date(),
          })
          .where(eq(removalRequests.id, reqRow.id));
      } else {
        const deadlineAt = new Date(now.getTime() + broker.legalSlaDays * 86400_000);
        await db
          .update(removalRequests)
          .set({
            status: execResult.outcomeStatus,
            actionReasonCode: execResult.actionReasonCode,
            actionReasonDetail: execResult.actionReasonDetail,
            retryCount: nextAttempts - 1,
            sentAt: execResult.outcomeStatus === 'SENT' ? now : reqRow.sentAt,
            deadlineAt: execResult.outcomeStatus === 'SENT' ? deadlineAt : reqRow.deadlineAt,
            updatedAt: now,
          })
          .where(eq(removalRequests.id, reqRow.id));

        await db
          .update(automationJobs)
          .set({
            status: 'COMPLETED',
            attempts: nextAttempts,
            updatedAt: now,
          })
          .where(eq(automationJobs.id, job.id));
      }

      const encryptedLog = encryptWithKey(
        `${emailSummary}\n\n--- GENERATED NOTICE ---\n${pdfResult.plainTextSummary}`,
        dek,
        `request_logs:${userRow.id}:${reqRow.id}`
      );

      await db.insert(requestLogs).values({
        requestId: reqRow.id,
        userId: userRow.id,
        direction: 'OUTBOUND',
        channel: execResult.channel,
        eventType: execResult.eventType,
        payloadEnc: encryptedLog.ciphertext,
        payloadIv: encryptedLog.iv,
        payloadTag: encryptedLog.authTag,
        documentSha256: pdfResult.sha256,
        httpStatus: execResult.httpStatus,
      });

      processed += 1;
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const errMsg = error instanceof Error ? error.message : 'Worker job error';
      const isFinal = nextAttempts >= job.maxAttempts;
      await db
        .update(automationJobs)
        .set({
          status: isFinal ? 'FAILED' : 'RETRY_WAIT',
          attempts: nextAttempts,
          nextRunAt: new Date(Date.now() + Math.pow(2, nextAttempts) * 60_000),
          lastError: errMsg,
          updatedAt: new Date(),
        })
        .where(eq(automationJobs.id, job.id));
    }
  }

  return processed;
}
