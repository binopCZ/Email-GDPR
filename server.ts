import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import JSZip from 'jszip';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { createServer as createViteServer } from 'vite';
import { db } from './src/db/index.ts';
import {
  aliasMailboxes,
  automationJobs,
  brokers,
  removalRequests,
  requestLogs,
  userPii,
  users,
} from './src/db/schema.ts';
import {
  authenticateEmailUser,
  decryptUserEmail,
  getOrCreateUser,
  registerEmailUser,
  rotateUserDek,
  shredUserAccount,
  unwrapUserDek,
} from './src/db/users.ts';
import {
  optionalAuth,
  requireAuth,
  SESSION_COOKIE_NAME,
  type AuthRequest,
} from './src/middleware/auth.ts';
import { createRateLimiter } from './src/middleware/rateLimit.ts';
import {
  computeBlindIndex,
  decryptWithKey,
  encryptWithKey,
  sha256Hex,
  signSessionToken,
} from './src/security/crypto.ts';
import {
  generateAuthorityComplaintPdf,
  generateErasureNoticePdf,
} from './src/services/pdfGenerator.ts';
import {
  runComplianceSchedulerSweep,
  startComplianceScheduler,
} from './src/services/scheduler.ts';
import { processPendingAutomationJobs } from './src/services/workerQueue.ts';

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ALLOWED_PII_TYPES = new Set([
  'FULL_NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'DOB',
  'ALT_NAME',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setSessionCookie(res: express.Response, req: express.Request, token: string) {
  const isHttps =
    req.secure || req.headers['x-forwarded-proto'] === 'https' || req.hostname !== 'localhost';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res: express.Response, req: express.Request) {
  const isHttps =
    req.secure || req.headers['x-forwarded-proto'] === 'https' || req.hostname !== 'localhost';
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    path: '/',
  });
}

function classifyInboundReply(text: string): 'DELETED' | 'ACTION_REQUIRED' | 'IN_REVIEW' {
  const lower = text.toLowerCase();
  if (
    lower.includes('deleted') ||
    lower.includes('erased') ||
    lower.includes('removed') ||
    lower.includes('vymazán') ||
    lower.includes('smazán') ||
    lower.includes('potvrzujeme výmaz')
  ) {
    return 'DELETED';
  }
  if (
    lower.includes('verify') ||
    lower.includes('confirm') ||
    lower.includes('captcha') ||
    lower.includes('identity') ||
    lower.includes('totožnost') ||
    lower.includes('potvrďte') ||
    lower.includes('odkaz')
  ) {
    return 'ACTION_REQUIRED';
  }
  return 'IN_REVIEW';
}

async function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  const authRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 25,
    message: 'Příliš mnoho pokusů o přihlášení nebo registraci. Zkuste to prosím za 15 minut.',
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'privavault-api', timestamp: new Date().toISOString() });
  });

  // Session hydration endpoint (uses HttpOnly cookie or Bearer token)
  app.get('/api/auth/session', optionalAuth, async (req: AuthRequest, res) => {
    if (!req.user?.uid || !req.user?.email) {
      return res.json({ authenticated: false, user: null });
    }
    try {
      const userRow = await getOrCreateUser(req.user.uid, req.user.email);
      const decryptedEmail = decryptUserEmail(userRow);
      res.json({
        authenticated: true,
        provider: req.user.uid.startsWith('email:') ? 'email' : 'google',
        user: {
          id: userRow.id,
          email: decryptedEmail,
          subscriptionTier: userRow.subscriptionTier,
          accountStatus: userRow.accountStatus,
          poaSignedAt: userRow.poaSignedAt,
          kekVersion: userRow.kekVersion,
          createdAt: userRow.createdAt,
        },
      });
    } catch (error) {
      console.error('Failed to hydrate session:', error);
      res.json({ authenticated: false, user: null });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res, req);
    res.json({ loggedOut: true });
  });

  // Universal Email + Password registration (supports @seznam.cz, @email.cz, @centrum.cz, etc.)
  app.post('/api/auth/register', authRateLimiter, async (req, res) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: 'Zadejte prosím platnou e-mailovou adresu.' });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Heslo musí mít alespoň 8 znaků.' });
      }
      const userRow = await registerEmailUser(email, password);
      const decryptedEmail = decryptUserEmail(userRow);
      const token = signSessionToken(userRow.uid, decryptedEmail);
      setSessionCookie(res, req, token);

      res.status(201).json({
        token,
        user: {
          id: userRow.id,
          email: decryptedEmail,
          subscriptionTier: userRow.subscriptionTier,
          accountStatus: userRow.accountStatus,
          poaSignedAt: userRow.poaSignedAt,
          kekVersion: userRow.kekVersion,
          createdAt: userRow.createdAt,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registrace se nezdařila.';
      const status = message.includes('již existuje') ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // Universal Email + Password login
  app.post('/api/auth/login', authRateLimiter, async (req, res) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !EMAIL_PATTERN.test(email.trim()) || !password) {
        return res.status(400).json({ error: 'Zadejte platný e-mail a heslo.' });
      }
      const userRow = await authenticateEmailUser(email, password);
      if (!userRow) {
        return res.status(401).json({ error: 'Nesprávný e-mail nebo heslo.' });
      }
      const decryptedEmail = decryptUserEmail(userRow);
      const token = signSessionToken(userRow.uid, decryptedEmail);
      setSessionCookie(res, req, token);

      res.json({
        token,
        user: {
          id: userRow.id,
          email: decryptedEmail,
          subscriptionTier: userRow.subscriptionTier,
          accountStatus: userRow.accountStatus,
          poaSignedAt: userRow.poaSignedAt,
          kekVersion: userRow.kekVersion,
          createdAt: userRow.createdAt,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Přihlášení se nezdařilo.';
      res.status(400).json({ error: message });
    }
  });

  // Inbound Email Webhook for automated broker replies (SendGrid/Mailgun/Resend parse)
  app.post('/api/webhooks/inbound-email', async (req, res) => {
    try {
      const configuredSecret = process.env.INBOUND_WEBHOOK_SECRET?.trim();
      const providedSecret = req.headers['x-webhook-secret']?.toString();
      if (configuredSecret && configuredSecret !== 'CHANGE_ME_WEBHOOK_SECRET') {
        if (providedSecret !== configuredSecret) {
          return res.status(401).json({ error: 'Invalid webhook secret.' });
        }
      }

      const { to, from, subject, text } = req.body as {
        to?: string;
        from?: string;
        subject?: string;
        text?: string;
      };
      if (!to || !text) {
        return res.status(400).json({ error: 'Missing recipient alias (to) or message text.' });
      }

      const aliasAddr = to.trim().toLowerCase();
      const aliasRows = await db
        .select()
        .from(aliasMailboxes)
        .where(eq(aliasMailboxes.aliasAddress, aliasAddr))
        .limit(1);

      if (aliasRows.length === 0) {
        return res.status(404).json({ error: 'Alias mailbox not found.' });
      }

      const aliasRow = aliasRows[0];
      const reqRows = await db
        .select({ request: removalRequests, user: users, broker: brokers })
        .from(removalRequests)
        .innerJoin(users, eq(removalRequests.userId, users.id))
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .where(
          and(
            eq(removalRequests.userId, aliasRow.userId),
            eq(removalRequests.brokerId, aliasRow.brokerId)
          )
        )
        .limit(1);

      if (reqRows.length === 0) {
        return res.status(404).json({ error: 'Matching removal request not found.' });
      }

      const { request: currentReq, user: userRow, broker } = reqRows[0];
      const dek = unwrapUserDek(userRow);
      const nextStatus = classifyInboundReply(`${subject ?? ''}\n${text}`);
      const now = new Date();
      const nextCycleAt =
        nextStatus === 'DELETED'
          ? new Date(now.getTime() + broker.recheckIntervalDays * 86400_000)
          : currentReq.nextCycleAt;

      await db
        .update(removalRequests)
        .set({
          status: nextStatus,
          deletedAt: nextStatus === 'DELETED' ? now : currentReq.deletedAt,
          nextCycleAt,
          actionReasonCode: nextStatus === 'ACTION_REQUIRED' ? 'BROKER_VERIFICATION' : null,
          actionReasonDetail:
            nextStatus === 'ACTION_REQUIRED'
              ? `Broker ${broker.name} si vyžádal doplňující potvrzení v e-mailu.`
              : null,
          updatedAt: now,
        })
        .where(eq(removalRequests.id, currentReq.id));

      const encryptedReply = encryptWithKey(
        `From: ${from ?? broker.dpoEmail ?? broker.domain}\nSubject: ${subject ?? '(bez předmětu)'}\n\n${text}`,
        dek,
        `request_logs:${userRow.id}:${currentReq.id}`
      );

      await db.insert(requestLogs).values({
        requestId: currentReq.id,
        userId: userRow.id,
        direction: 'INBOUND',
        channel: 'EMAIL_WEBHOOK',
        eventType: `BROKER_REPLY_${nextStatus}`,
        payloadEnc: encryptedReply.ciphertext,
        payloadIv: encryptedReply.iv,
        payloadTag: encryptedReply.authTag,
        httpStatus: 200,
      });

      res.json({ processed: true, requestId: currentReq.id, status: nextStatus });
    } catch (error) {
      console.error('Inbound webhook error:', error);
      res.status(500).json({ error: 'Failed to process inbound broker reply.' });
    }
  });

  // Public + user-custom broker directory
  app.get('/api/brokers', optionalAuth, async (req: AuthRequest, res) => {
    try {
      if (req.user?.uid) {
        const userRows = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.uid, req.user.uid))
          .limit(1);
        if (userRows.length > 0) {
          const rows = await db
            .select()
            .from(brokers)
            .where(
              or(isNull(brokers.createdByUserId), eq(brokers.createdByUserId, userRows[0].id))
            )
            .orderBy(desc(brokers.isCustom), brokers.name);
          return res.json({ brokers: rows });
        }
      }

      const rows = await db
        .select()
        .from(brokers)
        .where(isNull(brokers.createdByUserId))
        .orderBy(brokers.name);
      res.json({ brokers: rows });
    } catch (error) {
      console.error('Failed to fetch brokers:', error);
      res.status(500).json({ error: 'Unable to load data broker registry.' });
    }
  });

  // Add custom company / e-shop / portal to user's private broker directory
  app.post('/api/brokers/custom', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const { name, domain, dpoEmail, optOutUrl, jurisdiction } = req.body as {
        name?: string;
        domain?: string;
        dpoEmail?: string;
        optOutUrl?: string;
        jurisdiction?: 'GDPR' | 'CCPA' | 'GLOBAL';
      };

      if (!name || name.trim().length < 2) {
        return res.status(400).json({ error: 'Zadejte název firmy nebo portálu.' });
      }
      if (!domain || !domain.includes('.')) {
        return res.status(400).json({ error: 'Zadejte platnou doménu (např. eshop.cz).' });
      }
      if (!dpoEmail || !EMAIL_PATTERN.test(dpoEmail.trim())) {
        return res.status(400).json({ error: 'Zadejte kontaktní e-mail (DPO / GDPR podpora).' });
      }

      const userRow = await getOrCreateUser(uid, email);
      const cleanDomain = domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
      const slugBase = cleanDomain.replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const slug = `custom-${userRow.id.slice(0, 8)}-${slugBase}-${crypto.randomBytes(2).toString('hex')}`;

      const chosenJurisdiction: 'GDPR' | 'CCPA' | 'GLOBAL' =
        jurisdiction === 'CCPA' || jurisdiction === 'GLOBAL' ? jurisdiction : 'GDPR';

      const inserted = await db
        .insert(brokers)
        .values({
          slug,
          name: name.trim(),
          domain: cleanDomain,
          jurisdiction: chosenJurisdiction,
          riskLevel: 'MEDIUM',
          removalMethod: 'EMAIL_DPO',
          dpoEmail: dpoEmail.trim().toLowerCase(),
          optOutUrl: optOutUrl?.trim() || null,
          automationConfig: { channel: 'EMAIL_DPO', custom: true },
          brokerStatus: 'ACTIVE',
          legalSlaDays: 30,
          recheckIntervalDays: 90,
          isCustom: true,
          createdByUserId: userRow.id,
        })
        .returning();

      res.status(201).json({ broker: inserted[0] });
    } catch (error) {
      console.error('Failed in POST /api/brokers/custom:', error);
      res.status(400).json({
        error: 'Tento subjekt se nepodařilo přidat (doména už může být v seznamu).',
      });
    }
  });

  // Authenticated user profile
  app.get('/api/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) {
        return res.status(401).json({ error: 'Invalid user token claims.' });
      }
      const userRow = await getOrCreateUser(uid, email);
      const decryptedEmail = decryptUserEmail(userRow);

      res.json({
        user: {
          id: userRow.id,
          email: decryptedEmail,
          subscriptionTier: userRow.subscriptionTier,
          accountStatus: userRow.accountStatus,
          poaSignedAt: userRow.poaSignedAt,
          kekVersion: userRow.kekVersion,
          createdAt: userRow.createdAt,
        },
      });
    } catch (error) {
      console.error('Failed in GET /api/me:', error);
      res.status(500).json({ error: 'Failed to load user profile.' });
    }
  });

  // Sign Power of Attorney (GDPR authorization)
  app.post('/api/me/poa', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const clientIp = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
      const ipHash = sha256Hex(clientIp);
      const now = new Date();

      const updated = await db
        .update(users)
        .set({
          poaSignedAt: now,
          poaIpHash: ipHash,
          updatedAt: now,
        })
        .where(eq(users.id, userRow.id))
        .returning();

      res.json({ poaSignedAt: updated[0].poaSignedAt });
    } catch (error) {
      console.error('Failed in POST /api/me/poa:', error);
      res.status(500).json({ error: 'Failed to record Power of Attorney.' });
    }
  });

  // Rotate user's personal DEK (re-encrypts all PII and audit logs atomically)
  app.post('/api/me/rotate-dek', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const summary = await rotateUserDek(userRow);
      res.json({
        rotated: true,
        newVersion: userRow.kekVersion + 1,
        ...summary,
      });
    } catch (error) {
      console.error('Failed in POST /api/me/rotate-dek:', error);
      res.status(500).json({ error: 'Nepodařilo se přegenerovat šifrovací klíč.' });
    }
  });

  // Export full GDPR evidence archive (.zip) with PDF notices, manifest, and decrypted audit logs
  app.get('/api/me/export', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);
      const decryptedEmail = decryptUserEmail(userRow);

      const piiRows = await db
        .select()
        .from(userPii)
        .where(and(eq(userPii.userId, userRow.id), eq(userPii.isActive, true)));

      const piiExport = piiRows.map((row) => ({
        id: row.id,
        piiType: row.piiType,
        profileLabel: row.profileLabel,
        value: decryptWithKey(
          row.valueCiphertext,
          row.valueIv,
          row.valueAuthTag,
          dek,
          `user_pii:${userRow.id}:${row.piiType}`
        ),
        createdAt: row.createdAt,
      }));

      const fullName =
        piiExport.find((i) => i.piiType === 'FULL_NAME' || i.piiType === 'ALT_NAME')?.value ??
        decryptedEmail;

      const reqRows = await db
        .select({ request: removalRequests, broker: brokers, alias: aliasMailboxes })
        .from(removalRequests)
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .leftJoin(aliasMailboxes, eq(removalRequests.aliasId, aliasMailboxes.id))
        .where(eq(removalRequests.userId, userRow.id));

      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            accountEmail: decryptedEmail,
            poaSignedAt: userRow.poaSignedAt,
            piiCount: piiExport.length,
            requestsCount: reqRows.length,
          },
          null,
          2
        )
      );
      zip.file('vault-pii.json', JSON.stringify(piiExport, null, 2));

      for (const row of reqRows) {
        const pdf = await generateErasureNoticePdf({
          requestId: row.request.id,
          legalBasis: row.request.legalBasis,
          brokerName: row.broker.name,
          brokerDomain: row.broker.domain,
          dpoEmail: row.broker.dpoEmail,
          aliasEmail: row.alias?.aliasAddress ?? 'relay@privavault.local',
          fullName,
          identifiers: piiExport.map((p) => ({ type: p.piiType, value: p.value })),
          poaSignedAt: userRow.poaSignedAt,
          issuedAt: row.request.sentAt ?? row.request.createdAt,
        });
        zip.file(`notices/${row.broker.slug}-${row.request.id.slice(0, 8)}.pdf`, pdf.buffer);

        const logs = await db
          .select()
          .from(requestLogs)
          .where(
            and(eq(requestLogs.requestId, row.request.id), eq(requestLogs.userId, userRow.id))
          )
          .orderBy(requestLogs.createdAt);

        const logLines = logs.map((l) => {
          const payload =
            l.payloadEnc && l.payloadIv && l.payloadTag
              ? decryptWithKey(
                  l.payloadEnc,
                  l.payloadIv,
                  l.payloadTag,
                  dek,
                  `request_logs:${userRow.id}:${row.request.id}`
                )
              : '';
          return `[${l.createdAt.toISOString()}] ${l.eventType} (${l.channel}) SHA256=${
            l.documentSha256 ?? 'n/a'
          }\n${payload}\n`;
        });
        zip.file(`audit-logs/${row.broker.slug}.txt`, logLines.join('\n---\n'));
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="privavault-gdpr-archive.zip"');
      res.send(zipBuffer);
    } catch (error) {
      console.error('Failed in GET /api/me/export:', error);
      res.status(500).json({ error: 'Nepodařilo se vygenerovat GDPR archiv.' });
    }
  });

  // Cryptographic shredding: delete user account, destroy DEK, wipe all PII & requests
  app.delete('/api/me/account', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      await shredUserAccount(userRow.id);
      clearSessionCookie(res, req);
      res.json({ shredded: true });
    } catch (error) {
      console.error('Failed in DELETE /api/me/account:', error);
      res.status(500).json({ error: 'Nepodařilo se smazat účet.' });
    }
  });

  // List & decrypt user's PII identifiers
  app.get('/api/pii', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);

      const records = await db
        .select()
        .from(userPii)
        .where(and(eq(userPii.userId, userRow.id), eq(userPii.isActive, true)))
        .orderBy(desc(userPii.createdAt));

      const decrypted = records.map((row) => ({
        id: row.id,
        piiType: row.piiType,
        profileLabel: row.profileLabel,
        value: decryptWithKey(
          row.valueCiphertext,
          row.valueIv,
          row.valueAuthTag,
          dek,
          `user_pii:${userRow.id}:${row.piiType}`
        ),
        keyVersion: row.keyVersion,
        createdAt: row.createdAt,
      }));

      res.json({ pii: decrypted });
    } catch (error) {
      console.error('Failed in GET /api/pii:', error);
      res.status(500).json({ error: 'Failed to decrypt personal identifiers.' });
    }
  });

  // Encrypt & store a new PII identifier
  app.post('/api/pii', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const { piiType, value, profileLabel } = req.body as {
        piiType?: string;
        value?: string;
        profileLabel?: string;
      };

      if (!piiType || !ALLOWED_PII_TYPES.has(piiType)) {
        return res.status(400).json({ error: 'Invalid piiType.' });
      }
      if (!value || typeof value !== 'string' || value.trim().length < 2) {
        return res.status(400).json({ error: 'Value must be at least 2 characters.' });
      }

      const trimmed = value.trim();
      const label = (profileLabel?.trim() || 'Primary').slice(0, 50);
      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);

      const blindIdx = computeBlindIndex(`${piiType}:${trimmed}`);
      const encrypted = encryptWithKey(trimmed, dek, `user_pii:${userRow.id}:${piiType}`);

      const typedPiiType = piiType as
        | 'FULL_NAME'
        | 'EMAIL'
        | 'PHONE'
        | 'ADDRESS'
        | 'DOB'
        | 'ALT_NAME';

      const inserted = await db
        .insert(userPii)
        .values({
          userId: userRow.id,
          piiType: typedPiiType,
          profileLabel: label,
          valueCiphertext: encrypted.ciphertext,
          valueIv: encrypted.iv,
          valueAuthTag: encrypted.authTag,
          valueBlindIdx: blindIdx,
          keyVersion: userRow.kekVersion,
        })
        .onConflictDoUpdate({
          target: [userPii.userId, userPii.piiType, userPii.valueBlindIdx],
          set: {
            isActive: true,
            profileLabel: label,
            valueCiphertext: encrypted.ciphertext,
            valueIv: encrypted.iv,
            valueAuthTag: encrypted.authTag,
            updatedAt: new Date(),
          },
        })
        .returning();

      res.status(201).json({
        item: {
          id: inserted[0].id,
          piiType: inserted[0].piiType,
          profileLabel: inserted[0].profileLabel,
          value: trimmed,
          keyVersion: inserted[0].keyVersion,
          createdAt: inserted[0].createdAt,
        },
      });
    } catch (error) {
      console.error('Failed in POST /api/pii:', error);
      res.status(500).json({ error: 'Failed to encrypt and store personal data.' });
    }
  });

  app.delete('/api/pii/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const id = String(req.params.id);

      await db.delete(userPii).where(and(eq(userPii.id, id), eq(userPii.userId, userRow.id)));
      res.json({ deleted: true });
    } catch (error) {
      console.error('Failed in DELETE /api/pii/:id:', error);
      res.status(500).json({ error: 'Failed to delete personal identifier.' });
    }
  });

  // List user's erasure requests with broker, alias & active worker job status
  app.get('/api/requests', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);

      const rows = await db
        .select({
          request: removalRequests,
          broker: brokers,
          alias: aliasMailboxes,
        })
        .from(removalRequests)
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .leftJoin(aliasMailboxes, eq(removalRequests.aliasId, aliasMailboxes.id))
        .where(eq(removalRequests.userId, userRow.id))
        .orderBy(desc(removalRequests.updatedAt));

      const items = rows.map((r) => ({
        id: r.request.id,
        status: r.request.status,
        legalBasis: r.request.legalBasis,
        cycleNumber: r.request.cycleNumber,
        actionReasonCode: r.request.actionReasonCode,
        actionReasonDetail: r.request.actionReasonDetail,
        retryCount: r.request.retryCount,
        sentAt: r.request.sentAt,
        deadlineAt: r.request.deadlineAt,
        deletedAt: r.request.deletedAt,
        nextCycleAt: r.request.nextCycleAt,
        createdAt: r.request.createdAt,
        updatedAt: r.request.updatedAt,
        aliasAddress: r.alias?.aliasAddress ?? null,
        aliasStatus: r.alias?.status ?? null,
        broker: {
          id: r.broker.id,
          slug: r.broker.slug,
          name: r.broker.name,
          domain: r.broker.domain,
          jurisdiction: r.broker.jurisdiction,
          riskLevel: r.broker.riskLevel,
          removalMethod: r.broker.removalMethod,
          dpoEmail: r.broker.dpoEmail,
          optOutUrl: r.broker.optOutUrl,
          brokerStatus: r.broker.brokerStatus,
          legalSlaDays: r.broker.legalSlaDays,
          recheckIntervalDays: r.broker.recheckIntervalDays,
          requiresIdCheck: r.broker.requiresIdCheck,
          isCustom: r.broker.isCustom,
        },
      }));

      res.json({ requests: items });
    } catch (error) {
      console.error('Failed in GET /api/requests:', error);
      res.status(500).json({ error: 'Failed to load erasure requests.' });
    }
  });

  // Launch automated GDPR/CCPA erasure campaign via worker queue
  app.post('/api/requests/launch', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);

      const piiRows = await db
        .select()
        .from(userPii)
        .where(and(eq(userPii.userId, userRow.id), eq(userPii.isActive, true)));

      if (piiRows.length === 0) {
        return res
          .status(400)
          .json({ error: 'Nejdříve přidejte alespoň jeden osobní údaj do trezoru.' });
      }

      const { brokerIds, legalBasis } = req.body as {
        brokerIds?: string[];
        legalBasis?: 'GDPR_ART_17' | 'CCPA_1798_105';
      };

      const chosenBasis: 'GDPR_ART_17' | 'CCPA_1798_105' =
        legalBasis === 'CCPA_1798_105' ? 'CCPA_1798_105' : 'GDPR_ART_17';

      const targetBrokers =
        Array.isArray(brokerIds) && brokerIds.length > 0
          ? await db
              .select()
              .from(brokers)
              .where(
                and(
                  inArray(brokers.id, brokerIds),
                  or(isNull(brokers.createdByUserId), eq(brokers.createdByUserId, userRow.id))
                )
              )
          : await db
              .select()
              .from(brokers)
              .where(or(isNull(brokers.createdByUserId), eq(brokers.createdByUserId, userRow.id)));

      const relayDomain = process.env.ALIAS_RELAY_DOMAIN || 'relay.privavault.local';
      let queuedCount = 0;

      for (const broker of targetBrokers) {
        if (broker.brokerStatus === 'DEPRECATED' || broker.brokerStatus === 'MAINTENANCE') {
          continue;
        }

        const existingAlias = await db
          .select()
          .from(aliasMailboxes)
          .where(
            and(eq(aliasMailboxes.userId, userRow.id), eq(aliasMailboxes.brokerId, broker.id))
          )
          .limit(1);

        let aliasRow = existingAlias[0];
        if (!aliasRow) {
          const token = crypto.randomBytes(5).toString('hex');
          const insertedAlias = await db
            .insert(aliasMailboxes)
            .values({
              userId: userRow.id,
              brokerId: broker.id,
              aliasAddress: `req-${broker.slug.slice(0, 10)}-${token}@${relayDomain}`,
              status: 'ACTIVE',
            })
            .returning();
          aliasRow = insertedAlias[0];
        }

        const existingReq = await db
          .select()
          .from(removalRequests)
          .where(
            and(eq(removalRequests.userId, userRow.id), eq(removalRequests.brokerId, broker.id))
          )
          .limit(1);

        let requestRow = existingReq[0];
        if (!requestRow) {
          const insertedReq = await db
            .insert(removalRequests)
            .values({
              userId: userRow.id,
              piiId: piiRows[0].id,
              brokerId: broker.id,
              aliasId: aliasRow.id,
              legalBasis: chosenBasis,
              status: 'QUEUED',
              cycleNumber: 1,
            })
            .returning();
          requestRow = insertedReq[0];
        } else if (requestRow.status === 'DELETED') {
          continue;
        }

        await db.insert(automationJobs).values({
          requestId: requestRow.id,
          userId: userRow.id,
          brokerId: broker.id,
          jobType:
            broker.removalMethod === 'WEB_FORM' ? 'WEB_FORM_AUTOMATION' : 'EMAIL_DISPATCH',
          status: 'QUEUED',
          attempts: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
        });

        queuedCount += 1;
      }

      // Immediately process queued jobs for responsive UX while backoff retries stay scheduled
      const processedCount = await processPendingAutomationJobs(userRow.id);

      res.status(201).json({ launchedCount: queuedCount, processedCount });
    } catch (error) {
      console.error('Failed in POST /api/requests/launch:', error);
      res.status(500).json({ error: 'Failed to launch automated erasure requests.' });
    }
  });

  // Record a broker reply from the UI (passes through same classifier + encrypted log)
  app.post('/api/requests/:id/reply', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);
      const requestId = String(req.params.id);
      const { text } = req.body as { text?: string };

      if (!text || text.trim().length < 2) {
        return res.status(400).json({ error: 'Zadejte text odpovědi od brokera.' });
      }

      const existing = await db
        .select({ request: removalRequests, broker: brokers })
        .from(removalRequests)
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .where(and(eq(removalRequests.id, requestId), eq(removalRequests.userId, userRow.id)))
        .limit(1);

      if (existing.length === 0) {
        return res.status(404).json({ error: 'Removal request not found.' });
      }

      const { request: currentReq, broker } = existing[0];
      const nextStatus = classifyInboundReply(text);
      const now = new Date();
      const nextCycleAt =
        nextStatus === 'DELETED'
          ? new Date(now.getTime() + broker.recheckIntervalDays * 86400_000)
          : currentReq.nextCycleAt;

      const updated = await db
        .update(removalRequests)
        .set({
          status: nextStatus,
          deletedAt: nextStatus === 'DELETED' ? now : currentReq.deletedAt,
          nextCycleAt,
          actionReasonCode: nextStatus === 'ACTION_REQUIRED' ? 'BROKER_VERIFICATION' : null,
          actionReasonDetail:
            nextStatus === 'ACTION_REQUIRED'
              ? `Odpověď od ${broker.name} vyžaduje potvrzení nebo ověření totožnosti.`
              : null,
          updatedAt: now,
        })
        .where(eq(removalRequests.id, currentReq.id))
        .returning();

      const encryptedReply = encryptWithKey(
        `Incoming reply logged by client:\n\n${text.trim()}`,
        dek,
        `request_logs:${userRow.id}:${currentReq.id}`
      );

      await db.insert(requestLogs).values({
        requestId: currentReq.id,
        userId: userRow.id,
        direction: 'INBOUND',
        channel: 'MANUAL_RELAY',
        eventType: `BROKER_REPLY_${nextStatus}`,
        payloadEnc: encryptedReply.ciphertext,
        payloadIv: encryptedReply.iv,
        payloadTag: encryptedReply.authTag,
        httpStatus: 200,
      });

      res.json({ request: updated[0], classifiedStatus: nextStatus });
    } catch (error) {
      console.error('Failed in POST /api/requests/:id/reply:', error);
      res.status(500).json({ error: 'Failed to log broker reply.' });
    }
  });

  // Update request status
  app.patch('/api/requests/:id/status', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);
      const requestId = String(req.params.id);

      const { status, note } = req.body as {
        status?: 'SENT' | 'IN_REVIEW' | 'ACTION_REQUIRED' | 'DELETED' | 'REJECTED' | 'ESCALATED';
        note?: string;
      };

      const validStatuses = new Set([
        'SENT',
        'IN_REVIEW',
        'ACTION_REQUIRED',
        'DELETED',
        'REJECTED',
        'ESCALATED',
      ]);
      if (!status || !validStatuses.has(status)) {
        return res.status(400).json({ error: 'Invalid status value.' });
      }

      const existing = await db
        .select({ request: removalRequests, broker: brokers })
        .from(removalRequests)
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .where(and(eq(removalRequests.id, requestId), eq(removalRequests.userId, userRow.id)))
        .limit(1);

      if (existing.length === 0) {
        return res.status(404).json({ error: 'Removal request not found.' });
      }

      const { request: currentReq, broker } = existing[0];
      const now = new Date();
      const nextCycleAt =
        status === 'DELETED'
          ? new Date(now.getTime() + broker.recheckIntervalDays * 86400_000)
          : currentReq.nextCycleAt;

      const updated = await db
        .update(removalRequests)
        .set({
          status,
          actionReasonCode: status === 'DELETED' || status === 'SENT' ? null : currentReq.actionReasonCode,
          actionReasonDetail: status === 'DELETED' || status === 'SENT' ? null : currentReq.actionReasonDetail,
          sentAt: status === 'SENT' && !currentReq.sentAt ? now : currentReq.sentAt,
          deadlineAt:
            status === 'SENT' && !currentReq.deadlineAt
              ? new Date(now.getTime() + broker.legalSlaDays * 86400_000)
              : currentReq.deadlineAt,
          deletedAt: status === 'DELETED' ? now : currentReq.deletedAt,
          nextCycleAt,
          updatedAt: now,
        })
        .where(eq(removalRequests.id, currentReq.id))
        .returning();

      const logMessage =
        note?.trim() ||
        (status === 'DELETED'
          ? `Erasure confirmed by ${broker.name}. Next re-check scheduled in ${broker.recheckIntervalDays} days.`
          : `Request status transitioned to ${status}.`);

      const encryptedLog = encryptWithKey(
        logMessage,
        dek,
        `request_logs:${userRow.id}:${currentReq.id}`
      );

      await db.insert(requestLogs).values({
        requestId: currentReq.id,
        userId: userRow.id,
        direction: 'SYSTEM',
        channel: 'WORKFLOW',
        eventType: `STATUS_${status}`,
        payloadEnc: encryptedLog.ciphertext,
        payloadIv: encryptedLog.iv,
        payloadTag: encryptedLog.authTag,
        httpStatus: 200,
      });

      res.json({ request: updated[0] });
    } catch (error) {
      console.error('Failed in PATCH /api/requests/:id/status:', error);
      res.status(500).json({ error: 'Failed to update request status.' });
    }
  });

  // Fetch & decrypt audit logs for a removal request
  app.get('/api/requests/:id/logs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);
      const requestId = String(req.params.id);

      const rows = await db
        .select()
        .from(requestLogs)
        .where(and(eq(requestLogs.requestId, requestId), eq(requestLogs.userId, userRow.id)))
        .orderBy(desc(requestLogs.createdAt));

      const logs = rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        channel: row.channel,
        eventType: row.eventType,
        documentSha256: row.documentSha256,
        httpStatus: row.httpStatus,
        createdAt: row.createdAt,
        payload:
          row.payloadEnc && row.payloadIv && row.payloadTag
            ? decryptWithKey(
                row.payloadEnc,
                row.payloadIv,
                row.payloadTag,
                dek,
                `request_logs:${userRow.id}:${requestId}`
              )
            : null,
      }));

      res.json({ logs });
    } catch (error) {
      console.error('Failed in GET /api/requests/:id/logs:', error);
      res.status(500).json({ error: 'Failed to load request audit logs.' });
    }
  });

  // Download generated GDPR/CCPA PDF notice
  app.get('/api/requests/:id/pdf', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);
      const requestId = String(req.params.id);

      const reqRows = await db
        .select({ request: removalRequests, broker: brokers, alias: aliasMailboxes })
        .from(removalRequests)
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .leftJoin(aliasMailboxes, eq(removalRequests.aliasId, aliasMailboxes.id))
        .where(and(eq(removalRequests.id, requestId), eq(removalRequests.userId, userRow.id)))
        .limit(1);

      if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found.' });

      const piiRows = await db
        .select()
        .from(userPii)
        .where(and(eq(userPii.userId, userRow.id), eq(userPii.isActive, true)));

      const decryptedIdentifiers = piiRows.map((row) => ({
        type: row.piiType,
        value: decryptWithKey(
          row.valueCiphertext,
          row.valueIv,
          row.valueAuthTag,
          dek,
          `user_pii:${userRow.id}:${row.piiType}`
        ),
      }));

      const fullName =
        decryptedIdentifiers.find((i) => i.type === 'FULL_NAME' || i.type === 'ALT_NAME')
          ?.value ?? decryptUserEmail(userRow);

      const { request: requestRow, broker, alias } = reqRows[0];
      const pdf = await generateErasureNoticePdf({
        requestId: requestRow.id,
        legalBasis: requestRow.legalBasis,
        brokerName: broker.name,
        brokerDomain: broker.domain,
        dpoEmail: broker.dpoEmail,
        aliasEmail: alias?.aliasAddress ?? 'relay@privavault.local',
        fullName,
        identifiers: decryptedIdentifiers,
        poaSignedAt: userRow.poaSignedAt,
        issuedAt: requestRow.sentAt ?? requestRow.createdAt,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="erasure-${broker.slug}-${requestRow.id.slice(0, 8)}.pdf"`
      );
      res.send(pdf.buffer);
    } catch (error) {
      console.error('Failed in GET /api/requests/:id/pdf:', error);
      res.status(500).json({ error: 'Failed to generate PDF notice.' });
    }
  });

  // Download formal ÚOOÚ / Supervisory Authority Escalation Complaint PDF
  app.get('/api/requests/:id/escalation-pdf', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const dek = unwrapUserDek(userRow);
      const requestId = String(req.params.id);

      const reqRows = await db
        .select({ request: removalRequests, broker: brokers, alias: aliasMailboxes })
        .from(removalRequests)
        .innerJoin(brokers, eq(removalRequests.brokerId, brokers.id))
        .leftJoin(aliasMailboxes, eq(removalRequests.aliasId, aliasMailboxes.id))
        .where(and(eq(removalRequests.id, requestId), eq(removalRequests.userId, userRow.id)))
        .limit(1);

      if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found.' });

      const piiRows = await db
        .select()
        .from(userPii)
        .where(and(eq(userPii.userId, userRow.id), eq(userPii.isActive, true)));

      const namePii = piiRows.find((r) => r.piiType === 'FULL_NAME' || r.piiType === 'ALT_NAME');
      const fullName = namePii
        ? decryptWithKey(
            namePii.valueCiphertext,
            namePii.valueIv,
            namePii.valueAuthTag,
            dek,
            `user_pii:${userRow.id}:${namePii.piiType}`
          )
        : decryptUserEmail(userRow);

      const logRows = await db
        .select()
        .from(requestLogs)
        .where(and(eq(requestLogs.requestId, requestId), eq(requestLogs.userId, userRow.id)))
        .orderBy(requestLogs.createdAt);

      const firstSha = logRows.find((l) => Boolean(l.documentSha256))?.documentSha256 ?? null;
      const auditEvents = logRows.map((l) => ({
        createdAt: l.createdAt,
        eventType: l.eventType,
        detail:
          l.payloadEnc && l.payloadIv && l.payloadTag
            ? decryptWithKey(
                l.payloadEnc,
                l.payloadIv,
                l.payloadTag,
                dek,
                `request_logs:${userRow.id}:${requestId}`
              )
            : l.channel,
      }));

      const { request: requestRow, broker, alias } = reqRows[0];
      const buffer = await generateAuthorityComplaintPdf({
        requestId: requestRow.id,
        legalBasis: requestRow.legalBasis,
        brokerName: broker.name,
        brokerDomain: broker.domain,
        dpoEmail: broker.dpoEmail,
        aliasEmail: alias?.aliasAddress ?? 'relay@privavault.local',
        fullName,
        sentAt: requestRow.sentAt,
        deadlineAt: requestRow.deadlineAt,
        originalPdfSha256: firstSha,
        auditEvents,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="uoou-podnet-${broker.slug}-${requestRow.id.slice(0, 8)}.pdf"`
      );
      res.send(buffer);
    } catch (error) {
      console.error('Failed in GET /api/requests/:id/escalation-pdf:', error);
      res.status(500).json({ error: 'Failed to generate escalation complaint PDF.' });
    }
  });

  // Trigger compliance scheduler + pending worker queue sweep for current user
  app.post('/api/scheduler/tick', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email;
      if (!uid || !email) return res.status(401).json({ error: 'Unauthorized.' });

      const userRow = await getOrCreateUser(uid, email);
      const processedJobs = await processPendingAutomationJobs(userRow.id);
      const summary = await runComplianceSchedulerSweep(userRow.id);
      res.json({ ...summary, processedJobs });
    } catch (error) {
      console.error('Failed in POST /api/scheduler/tick:', error);
      res.status(500).json({ error: 'Scheduler sweep failed.' });
    }
  });

  if (!IS_PRODUCTION) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PrivaVault server listening on port ${PORT}`);
    startComplianceScheduler();
  });
}

void createApp();
