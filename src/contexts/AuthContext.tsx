import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase.ts';

export interface ActiveSession {
  email: string;
  provider: 'google' | 'email';
}

interface AuthContextValue {
  session: ActiveSession | null;
  loading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearLocalSession: () => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [emailSession, setEmailSession] = useState<ActiveSession | null>(null);
  const emailTokenRef = useRef<string | null>(null);

  const [firebaseReady, setFirebaseReady] = useState(false);
  const [cookieChecked, setCookieChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setFirebaseReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        if (res.ok && active) {
          const data = (await res.json()) as {
            authenticated?: boolean;
            provider?: 'google' | 'email';
            user?: { email: string } | null;
          };
          if (data.authenticated && data.user?.email && data.provider === 'email') {
            setEmailSession({ email: data.user.email, provider: 'email' });
          }
        }
      } catch {
        // Ignore network errors during passive session hydration
      } finally {
        if (active) setCookieChecked(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      emailTokenRef.current = null;
      setEmailSession(null);
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Přihlášení přes Google se nezdařilo.';
      setAuthError(msg);
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json()) as {
      token?: string;
      user?: { email: string };
      error?: string;
    };
    if (!res.ok || !data.token || !data.user) {
      const message = data.error || 'Přihlášení se nezdařilo.';
      setAuthError(message);
      throw new Error(message);
    }
    emailTokenRef.current = data.token;
    setEmailSession({ email: data.user.email, provider: 'email' });
  }, []);

  const registerWithEmail = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json()) as {
      token?: string;
      user?: { email: string };
      error?: string;
    };
    if (!res.ok || !data.token || !data.user) {
      const message = data.error || 'Registrace se nezdařila.';
      setAuthError(message);
      throw new Error(message);
    }
    emailTokenRef.current = data.token;
    setEmailSession({ email: data.user.email, provider: 'email' });
  }, []);

  const clearLocalSession = useCallback(() => {
    emailTokenRef.current = null;
    setEmailSession(null);
    setFirebaseUser(null);
  }, []);

  const logout = useCallback(async () => {
    emailTokenRef.current = null;
    setEmailSession(null);
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    if (auth.currentUser) {
      await signOut(auth);
    }
  }, []);

  const apiFetch = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (emailTokenRef.current) {
      headers.set('Authorization', `Bearer ${emailTokenRef.current}`);
    } else if (auth.currentUser) {
      const token = await auth.currentUser.getIdToken();
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...options, headers, credentials: 'include' });
  }, []);

  const session: ActiveSession | null = emailSession
    ? emailSession
    : firebaseUser?.email
    ? { email: firebaseUser.email, provider: 'google' }
    : null;

  return (
    <AuthContext.Provider
      value={{
        session,
        loading: !firebaseReady || !cookieChecked,
        authError,
        signInWithGoogle,
        signInWithEmail,
        registerWithEmail,
        logout,
        clearLocalSession,
        apiFetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return ctx;
}
