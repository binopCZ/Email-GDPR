import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function getMasterKek(): Buffer {
  const configured = process.env.ENCRYPTION_KEK;
  if (configured && /^[0-9a-fA-F]{64}$/.test(configured.trim())) {
    return Buffer.from(configured.trim(), 'hex');
  }
  const seed = process.env.SQL_PASSWORD || firebaseConfig.projectId || 'privavault-dev-seed';
  return crypto.scryptSync(seed, 'privavault-kek-salt-v1', 32);
}

function getBlindIndexPepper(): string {
  return (
    process.env.BLIND_INDEX_PEPPER ||
    process.env.SQL_PASSWORD ||
    `${firebaseConfig.projectId}:blind-index-v1`
  );
}

export function generateDek(): Buffer {
  return crypto.randomBytes(32);
}

export function encryptWithKey(plaintext: string, key: Buffer, aadContext: string): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aadContext, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptWithKey(
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
  key: Buffer,
  aadContext: string
): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aadContext, 'utf8'));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export function encryptDek(dek: Buffer, uid: string): EncryptedPayload {
  const kek = getMasterKek();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, kek, iv);
  cipher.setAAD(Buffer.from(`dek:${uid}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptDek(
  dekCiphertext: Buffer,
  dekIv: Buffer,
  dekAuthTag: Buffer,
  uid: string
): Buffer {
  const kek = getMasterKek();
  const decipher = crypto.createDecipheriv(ALGORITHM, kek, dekIv);
  decipher.setAAD(Buffer.from(`dek:${uid}`, 'utf8'));
  decipher.setAuthTag(dekAuthTag);
  return Buffer.concat([decipher.update(dekCiphertext), decipher.final()]);
}

export function encryptMasterField(plaintext: string, aadContext: string): EncryptedPayload {
  return encryptWithKey(plaintext, getMasterKek(), aadContext);
}

export function decryptMasterField(
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
  aadContext: string
): string {
  return decryptWithKey(ciphertext, iv, authTag, getMasterKek(), aadContext);
}

export function computeBlindIndex(value: string): string {
  const normalized = value.trim().toLowerCase();
  return crypto
    .createHmac('sha256', getBlindIndexPepper())
    .update(normalized, 'utf8')
    .digest('hex');
}

export function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function getSessionSecret(): Buffer {
  return crypto.createHmac('sha256', getMasterKek()).update('session-token-v1').digest();
}

export interface SessionTokenClaims {
  uid: string;
  email: string;
  exp: number;
}

export function signSessionToken(uid: string, email: string, ttlSeconds = 86400 * 7): string {
  const claims: SessionTokenClaims = {
    uid,
    email,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');
  return `pv1.${payloadB64}.${sig}`;
}

export function verifySessionToken(token: string): SessionTokenClaims | null {
  if (!token.startsWith('pv1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest();
  const actualSig = Buffer.from(sigB64, 'base64url');
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as SessionTokenClaims;
    if (!decoded.uid || !decoded.email || decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
