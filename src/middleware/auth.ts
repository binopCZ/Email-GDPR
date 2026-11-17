import type { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { verifySessionToken } from '../security/crypto.ts';

export const SESSION_COOKIE_NAME = 'pv_session';

export interface AuthenticatedPrincipal {
  uid: string;
  email?: string;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedPrincipal;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

async function resolvePrincipal(req: Request): Promise<AuthenticatedPrincipal | null> {
  const authHeader = req.headers.authorization;
  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split('Bearer ')[1];
  } else {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE_NAME]) {
      token = cookies[SESSION_COOKIE_NAME];
    }
  }

  if (!token) return null;

  if (token.startsWith('pv1.')) {
    const claims = verifySessionToken(token);
    if (!claims) return null;
    return { uid: claims.uid, email: claims.email };
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    return { uid: decodedToken.uid, email: decodedToken.email };
  } catch {
    return null;
  }
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const principal = await resolvePrincipal(req);
  if (!principal) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid credentials' });
  }
  req.user = principal;
  next();
};

export const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  const principal = await resolvePrincipal(req);
  if (principal) {
    req.user = principal;
  }
  next();
};
