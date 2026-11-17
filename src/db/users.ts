import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import {
  aliasMailboxes,
  automationJobs,
  brokers,
  removalRequests,
  requestLogs,
  userPii,
  users,
} from './schema.ts';
import {
  computeBlindIndex,
  decryptDek,
  decryptMasterField,
  decryptWithKey,
  encryptDek,
  encryptMasterField,
  encryptWithKey,
  generateDek,
  hashPassword,
  verifyPassword,
} from '../security/crypto.ts';

export async function getOrCreateUser(uid: string, email: string) {
  try {
    const existing = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    const emailBlindIdx = computeBlindIndex(email);
    const encryptedEmail = encryptMasterField(email, `users:email:${uid}`);

    if (existing.length > 0) {
      const updated = await db
        .update(users)
        .set({
          emailBlindIdx,
          emailCiphertext: encryptedEmail.ciphertext,
          emailIv: encryptedEmail.iv,
          emailAuthTag: encryptedEmail.authTag,
          updatedAt: new Date(),
        })
        .where(eq(users.uid, uid))
        .returning();
      return updated[0];
    }

    const rawDek = generateDek();
    const wrappedDek = encryptDek(rawDek, uid);

    const inserted = await db
      .insert(users)
      .values({
        uid,
        emailBlindIdx,
        emailCiphertext: encryptedEmail.ciphertext,
        emailIv: encryptedEmail.iv,
        emailAuthTag: encryptedEmail.authTag,
        dekCiphertext: wrappedDek.ciphertext,
        dekIv: wrappedDek.iv,
        dekAuthTag: wrappedDek.authTag,
        kekVersion: 1,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          emailBlindIdx,
          emailCiphertext: encryptedEmail.ciphertext,
          emailIv: encryptedEmail.iv,
          emailAuthTag: encryptedEmail.authTag,
          updatedAt: new Date(),
        },
      })
      .returning();

    return inserted[0];
  } catch (error) {
    console.error('Database error in getOrCreateUser:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}

export async function registerEmailUser(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const emailBlindIdx = computeBlindIndex(normalized);
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.emailBlindIdx, emailBlindIdx))
    .limit(1);

  if (existing.length > 0) {
    throw new Error('Účet s tímto e-mailem již existuje. Přihlaste se prosím.');
  }

  const uid = `email:${crypto.randomUUID()}`;
  const encryptedEmail = encryptMasterField(normalized, `users:email:${uid}`);
  const rawDek = generateDek();
  const wrappedDek = encryptDek(rawDek, uid);
  const passwordHash = hashPassword(password);

  const inserted = await db
    .insert(users)
    .values({
      uid,
      emailBlindIdx,
      emailCiphertext: encryptedEmail.ciphertext,
      emailIv: encryptedEmail.iv,
      emailAuthTag: encryptedEmail.authTag,
      passwordHash,
      dekCiphertext: wrappedDek.ciphertext,
      dekIv: wrappedDek.iv,
      dekAuthTag: wrappedDek.authTag,
      kekVersion: 1,
    })
    .returning();

  return inserted[0];
}

export async function authenticateEmailUser(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const emailBlindIdx = computeBlindIndex(normalized);
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.emailBlindIdx, emailBlindIdx))
    .limit(1);

  if (existing.length === 0) {
    return null;
  }

  const userRow = existing[0];
  if (!userRow.passwordHash) {
    throw new Error('Tento účet byl vytvořen přes Google. Použijte prosím přihlášení přes Google.');
  }

  if (!verifyPassword(password, userRow.passwordHash)) {
    return null;
  }

  return userRow;
}

export function unwrapUserDek(userRow: typeof users.$inferSelect): Buffer {
  return decryptDek(userRow.dekCiphertext, userRow.dekIv, userRow.dekAuthTag, userRow.uid);
}

export function decryptUserEmail(userRow: typeof users.$inferSelect): string {
  return decryptMasterField(
    userRow.emailCiphertext,
    userRow.emailIv,
    userRow.emailAuthTag,
    `users:email:${userRow.uid}`
  );
}

/**
 * Rotates a user's Data Encryption Key (DEK) atomically by re-encrypting
 * all user_pii and request_logs payloads with a newly generated 256-bit DEK.
 */
export async function rotateUserDek(userRow: typeof users.$inferSelect) {
  const oldDek = unwrapUserDek(userRow);
  const newDek = generateDek();
  const wrappedNewDek = encryptDek(newDek, userRow.uid);

  const piiRows = await db.select().from(userPii).where(eq(userPii.userId, userRow.id));
  const logRows = await db.select().from(requestLogs).where(eq(requestLogs.userId, userRow.id));

  await db.transaction(async (tx) => {
    for (const pii of piiRows) {
      const aad = `user_pii:${userRow.id}:${pii.piiType}`;
      const plaintext = decryptWithKey(pii.valueCiphertext, pii.valueIv, pii.valueAuthTag, oldDek, aad);
      const reEncrypted = encryptWithKey(plaintext, newDek, aad);
      await tx
        .update(userPii)
        .set({
          valueCiphertext: reEncrypted.ciphertext,
          valueIv: reEncrypted.iv,
          valueAuthTag: reEncrypted.authTag,
          keyVersion: pii.keyVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(userPii.id, pii.id));
    }

    for (const log of logRows) {
      if (log.payloadEnc && log.payloadIv && log.payloadTag) {
        const aad = `request_logs:${userRow.id}:${log.requestId}`;
        const plaintext = decryptWithKey(log.payloadEnc, log.payloadIv, log.payloadTag, oldDek, aad);
        const reEncrypted = encryptWithKey(plaintext, newDek, aad);
        await tx
          .update(requestLogs)
          .set({
            payloadEnc: reEncrypted.ciphertext,
            payloadIv: reEncrypted.iv,
            payloadTag: reEncrypted.authTag,
          })
          .where(eq(requestLogs.id, log.id));
      }
    }

    await tx
      .update(users)
      .set({
        dekCiphertext: wrappedNewDek.ciphertext,
        dekIv: wrappedNewDek.iv,
        dekAuthTag: wrappedNewDek.authTag,
        kekVersion: userRow.kekVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userRow.id));
  });

  return { rotatedPiiCount: piiRows.length, rotatedLogCount: logRows.length };
}

/**
 * Cryptographic shredding: permanently destroys the user's DEK, PII, requests,
 * aliases, logs, custom brokers, and account record.
 */
export async function shredUserAccount(userId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(automationJobs).where(eq(automationJobs.userId, userId));
    await tx.delete(requestLogs).where(eq(requestLogs.userId, userId));
    await tx.delete(removalRequests).where(eq(removalRequests.userId, userId));
    await tx.delete(aliasMailboxes).where(eq(aliasMailboxes.userId, userId));
    await tx.delete(userPii).where(eq(userPii.userId, userId));
    await tx.delete(brokers).where(eq(brokers.createdByUserId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
