import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  Database,
  FileCheck2,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  X,
} from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import { PiiVault } from './components/PiiVault.tsx';
import { BrokerDirectory } from './components/BrokerDirectory.tsx';
import { RequestsTable } from './components/RequestsTable.tsx';
import { SecuritySettings } from './components/SecuritySettings.tsx';
import type {
  Broker,
  LegalBasis,
  PiiItem,
  PiiType,
  RemovalRequestItem,
  RemovalStatus,
  RequestLogItem,
  UserProfile,
} from './types/privacy.ts';

type ViewTab = 'overview' | 'vault' | 'requests' | 'brokers' | 'settings';

function DashboardShell() {
  const {
    session,
    loading: authLoading,
    authError,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    logout,
    clearLocalSession,
    apiFetch,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<ViewTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [piiItems, setPiiItems] = useState<PiiItem[]>([]);
  const [requests, setRequests] = useState<RemovalRequestItem[]>([]);

  const [dataLoading, setDataLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadBrokers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/brokers');
      if (res.ok) {
        const data = (await res.json()) as { brokers: Broker[] };
        setBrokers(data.brokers);
      }
    } catch (err) {
      console.error('Failed to load brokers:', err);
    }
  }, [apiFetch]);

  const loadAuthenticatedWorkspace = useCallback(async () => {
    if (!session) return;
    setDataLoading(true);
    try {
      const [meRes, piiRes, reqRes, brokersRes] = await Promise.all([
        apiFetch('/api/me'),
        apiFetch('/api/pii'),
        apiFetch('/api/requests'),
        apiFetch('/api/brokers'),
      ]);

      if (meRes.ok) {
        const meData = (await meRes.json()) as { user: UserProfile };
        setUserProfile(meData.user);
      }
      if (piiRes.ok) {
        const piiData = (await piiRes.json()) as { pii: PiiItem[] };
        setPiiItems(piiData.pii);
      }
      if (reqRes.ok) {
        const reqData = (await reqRes.json()) as { requests: RemovalRequestItem[] };
        setRequests(reqData.requests);
      }
      if (brokersRes.ok) {
        const brokerData = (await brokersRes.json()) as { brokers: Broker[] };
        setBrokers(brokerData.brokers);
      }
    } catch (err) {
      console.error('Workspace load error:', err);
      setBannerMessage({
        type: 'error',
        text: 'Nepodařilo se načíst data pracovního prostoru.',
      });
    } finally {
      setDataLoading(false);
    }
  }, [session, apiFetch]);

  useEffect(() => {
    if (!session) {
      void loadBrokers();
    }
  }, [session, loadBrokers]);

  useEffect(() => {
    if (session) {
      void loadAuthenticatedWorkspace();
    } else {
      setUserProfile(null);
      setPiiItems([]);
      setRequests([]);
    }
  }, [session, loadAuthenticatedWorkspace]);

  const metrics = useMemo(() => {
    const deleted = requests.filter((r) => r.status === 'DELETED').length;
    const inProgress = requests.filter((r) =>
      ['PENDING', 'QUEUED', 'SENT', 'IN_REVIEW'].includes(r.status)
    ).length;
    const actionRequired = requests.filter((r) => r.status === 'ACTION_REQUIRED').length;
    const escalated = requests.filter((r) =>
      ['REJECTED', 'ESCALATED'].includes(r.status)
    ).length;
    return {
      totalBrokers: brokers.length,
      deleted,
      inProgress,
      actionRequired,
      escalated,
    };
  }, [brokers.length, requests]);

  async function handleEmailAuthSubmit(e: FormEvent) {
    e.preventDefault();
    setAuthSubmitting(true);
    try {
      if (authMode === 'register') {
        await registerWithEmail(emailInput, passwordInput);
      } else {
        await signInWithEmail(emailInput, passwordInput);
      }
    } catch {
      // Surfaced via authError
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleSignPoa() {
    const res = await apiFetch('/api/me/poa', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { poaSignedAt: string };
      setUserProfile((prev) => (prev ? { ...prev, poaSignedAt: data.poaSignedAt } : prev));
      setBannerMessage({
        type: 'success',
        text: 'Plná moc k zastupování podle čl. 17 GDPR byla zaznamenána.',
      });
    }
  }

  async function handleAddPii(payload: {
    piiType: PiiType;
    value: string;
    profileLabel: string;
  }) {
    const res = await apiFetch('/api/pii', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { item?: PiiItem; error?: string };
    if (!res.ok || !data.item) {
      throw new Error(data.error || 'Chyba při ukládání údaje.');
    }
    setPiiItems((prev) => [data.item!, ...prev.filter((i) => i.id !== data.item!.id)]);
    setBannerMessage({
      type: 'success',
      text: 'Osobní údaj byl zašifrován pomocí AES-256-GCM a bezpečně uložen.',
    });
  }

  async function handleDeletePii(id: string) {
    const res = await apiFetch(`/api/pii/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setPiiItems((prev) => prev.filter((item) => item.id !== id));
    }
  }

  async function handleAddCustomBroker(payload: {
    name: string;
    domain: string;
    dpoEmail: string;
    jurisdiction: 'GDPR' | 'CCPA' | 'GLOBAL';
  }) {
    const res = await apiFetch('/api/brokers/custom', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { broker?: Broker; error?: string };
    if (!res.ok || !data.broker) {
      throw new Error(data.error || 'Nepodařilo se přidat vlastní subjekt.');
    }
    setBrokers((prev) => [data.broker!, ...prev]);
    setBannerMessage({
      type: 'success',
      text: `Vlastní subjekt ${data.broker.name} byl přidán do vašeho seznamu.`,
    });
  }

  async function handleLaunchRequests(brokerIds: string[], legalBasis: LegalBasis) {
    setLaunching(true);
    setBannerMessage(null);
    try {
      const res = await apiFetch('/api/requests/launch', {
        method: 'POST',
        body: JSON.stringify({ brokerIds, legalBasis }),
      });
      const data = (await res.json()) as { launchedCount?: number; error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Odeslání žádostí selhalo.');
      }
      await loadAuthenticatedWorkspace();
      setActiveTab('requests');
      setBannerMessage({
        type: 'success',
        text: `Zpracováno ${data.launchedCount ?? 0} žádostí o výmaz s izolovanými aliasy.`,
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Odeslání žádostí selhalo.',
      });
    } finally {
      setLaunching(false);
    }
  }

  async function handleStatusChange(id: string, status: RemovalStatus, note?: string) {
    const res = await apiFetch(`/api/requests/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note }),
    });
    if (res.ok) {
      await loadAuthenticatedWorkspace();
    }
  }

  async function handleRecordReply(id: string, text: string) {
    const res = await apiFetch(`/api/requests/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const data = (await res.json()) as { classifiedStatus: RemovalStatus };
      await loadAuthenticatedWorkspace();
      setBannerMessage({
        type: 'success',
        text: `Odpověď brokera byla zašifrována a automaticky zařazena do stavu ${data.classifiedStatus}.`,
      });
    }
  }

  async function handleDownloadPdf(id: string, brokerSlug: string) {
    const res = await apiFetch(`/api/requests/${id}/pdf`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `erasure-${brokerSlug}-${id.slice(0, 8)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleDownloadEscalationPdf(id: string, brokerSlug: string) {
    const res = await apiFetch(`/api/requests/${id}/escalation-pdf`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `uoou-podnet-${brokerSlug}-${id.slice(0, 8)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleLoadLogs(id: string): Promise<RequestLogItem[]> {
    const res = await apiFetch(`/api/requests/${id}/logs`);
    if (!res.ok) return [];
    const data = (await res.json()) as { logs: RequestLogItem[] };
    return data.logs;
  }

  async function handleSchedulerTick() {
    const res = await apiFetch('/api/scheduler/tick', { method: 'POST' });
    if (res.ok) {
      const summary = (await res.json()) as {
        escalatedCount: number;
        requeuedCount: number;
        processedJobs?: number;
      };
      await loadAuthenticatedWorkspace();
      setBannerMessage({
        type: 'success',
        text: `Kontrola lhůt dokončena: ${summary.escalatedCount} eskalací (30d SLA), ${summary.requeuedCount} re-cyklů, ${summary.processedJobs ?? 0} úloh ve frontě.`,
      });
    }
  }

  async function handleRotateDek() {
    const res = await apiFetch('/api/me/rotate-dek', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { newVersion: number; rotatedPiiCount: number };
      await loadAuthenticatedWorkspace();
      setBannerMessage({
        type: 'success',
        text: `Nový šifrovací klíč v${data.newVersion} aktivní (${data.rotatedPiiCount} PII záznamů přešifrováno).`,
      });
    }
  }

  async function handleExportArchive() {
    const res = await apiFetch('/api/me/export');
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'privavault-gdpr-archive.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleShredAccount() {
    const res = await apiFetch('/api/me/account', { method: 'DELETE' });
    if (res.ok) {
      clearLocalSession();
      setBannerMessage(null);
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-600">Načítání zabezpečeného prostoru...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <header className="bg-white border-b border-slate-200">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-8">
            <a
              href="/"
              className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
            >
              PrivaVault
            </a>

            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
              <a href="#auth-panel" className="hover:text-slate-900 whitespace-nowrap shrink-0">
                Přihlášení
              </a>
              <a href="#brokers" className="hover:text-slate-900 whitespace-nowrap shrink-0">
                Registr brokerů
              </a>
              <a href="#security" className="hover:text-slate-900 whitespace-nowrap shrink-0">
                Šifrování
              </a>
            </nav>

            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Přihlásit přes Google
            </button>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-12 space-y-12">
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-7 space-y-6">
              <p className="text-xs font-medium text-slate-500">
                Článek 17 GDPR · CCPA § 1798.105 · AES-256-GCM Trezor
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 text-balance">
                Automatizovaný výmaz osobních údajů z databází data brokerů
              </h1>
              <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
                Funguje s jakýmkoliv e-mailem (Seznam.cz, Email.cz, Centrum.cz, Proton, Outlook i Gmail). PrivaVault zašifruje vaše identifikátory, vygeneruje české i mezinárodní GDPR výzvy, komunikuje přes izolované aliasy a hlídá 30denní zákonné lhůty.
              </p>

              <div id="security" className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <Lock className="w-4 h-4 text-slate-900 mb-2" />
                  <div className="text-sm font-medium text-slate-900">AES-256-GCM Trezor</div>
                  <p className="text-xs text-slate-500 mt-1">
                    Vlastní šifrovací klíč (DEK) s podporou rotace i skartace.
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <Shield className="w-4 h-4 text-slate-900 mb-2" />
                  <div className="text-sm font-medium text-slate-900">Izolované aliasy</div>
                  <p className="text-xs text-slate-500 mt-1">
                    Váš Seznam či jiný e-mail zůstane před brokery skrytý.
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <Clock className="w-4 h-4 text-slate-900 mb-2" />
                  <div className="text-sm font-medium text-slate-900">Podněty na ÚOOÚ</div>
                  <p className="text-xs text-slate-500 mt-1">
                    Eskalace po 30d SLA a re-kontroly každých 60–90 dní.
                  </p>
                </div>
              </div>
            </div>

            <div
              id="auth-panel"
              className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5"
            >
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
                <h2 className="text-base font-semibold text-slate-900">
                  {authMode === 'register' ? 'Vytvořit účet e-mailem' : 'Přihlásit se e-mailem'}
                </h2>
                <div className="inline-flex p-0.5 bg-slate-100 rounded-md">
                  <button
                    type="button"
                    onClick={() => setAuthMode('register')}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                      authMode === 'register'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600'
                    }`}
                  >
                    Registrace
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode('login')}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                      authMode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    Přihlášení
                  </button>
                </div>
              </div>

              <form onSubmit={handleEmailAuthSubmit} className="space-y-4">
                <div>
                  <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                    E-mailová adresa (Seznam, Email.cz, Centrum, Gmail...)
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="jmeno@seznam.cz"
                    className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>

                <div>
                  <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                    Heslo (min. 8 znaků)
                  </label>
                  <input
                    id="auth-password"
                    type="password"
                    required
                    minLength={8}
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="••••••••"
                    className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>

                {authError && (
                  <p className="text-xs text-red-600" role="alert">
                    {authError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full h-10 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {authSubmitting
                    ? 'Zpracovávám...'
                    : authMode === 'register'
                    ? 'Vytvořit šifrovaný trezor'
                    : 'Přihlásit se do trezoru'}
                </button>
              </form>

              <div className="relative py-1 flex items-center">
                <div className="flex-grow border-t border-slate-200" />
                <span className="px-3 text-xs text-slate-400">nebo</span>
                <div className="flex-grow border-t border-slate-200" />
              </div>

              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="w-full h-10 px-4 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
              >
                Pokračovat přes Google účet
              </button>
            </div>
          </section>

          <section id="brokers" className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">
                Podporovaný registr data brokerů a portálů ({brokers.length})
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                Včetně českých registrů (Seznam.cz, Centrum.cz / Economia, MAFRA, Merk.cz, Kurzy.cz, Heureka) a globálních data brokerů.
              </p>
            </div>
            <BrokerDirectory
              brokers={brokers}
              loading={false}
              canLaunch={false}
              hasPii={false}
              launching={false}
              onLaunch={handleLaunchRequests}
            />
          </section>
        </main>
      </div>
    );
  }

  const navItems: Array<{ id: ViewTab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'overview', label: 'Přehled', icon: LayoutDashboard },
    { id: 'vault', label: 'Trezor údajů', icon: Lock },
    { id: 'requests', label: 'Žádosti o výmaz', icon: FileCheck2 },
    { id: 'brokers', label: 'Registr brokerů', icon: Database },
    { id: 'settings', label: 'Zabezpečení & Export', icon: Settings },
  ];

  const tabTitle = navItems.find((n) => n.id === activeTab)?.label ?? 'Přehled';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-white border-r border-slate-200 shrink-0">
        <div className="px-6 py-5 border-b border-slate-200">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            PrivaVault
          </span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full px-3 py-2.5 rounded-md text-sm font-medium flex items-center gap-3 transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs text-slate-600 truncate">
            {userProfile?.email ?? session.email}
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md flex items-center justify-center gap-2 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Odhlásit se</span>
          </button>
        </div>
      </aside>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden bg-slate-900/40 flex">
          <div className="w-64 bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <span className="font-display text-lg font-bold text-slate-900">PrivaVault</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Zavřít menu"
                className="p-1.5 text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full px-3 py-2.5 rounded-md text-sm font-medium flex items-center gap-3 ${
                      activeTab === item.id
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200">
              <button
                type="button"
                onClick={() => void logout()}
                className="w-full px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md"
              >
                Odhlásit se
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Otevřít navigaci"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span>PrivaVault</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="font-medium text-slate-900">{tabTitle}</span>
            </div>
          </div>

          <button
            type="button"
            disabled={launching || piiItems.length === 0}
            onClick={() =>
              void handleLaunchRequests(
                brokers.map((b) => b.id),
                'GDPR_ART_17'
              )
            }
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{launching ? 'Odesílám...' : 'Spustit vlnu výmazů'}</span>
          </button>
        </header>

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">
          {bannerMessage && (
            <div
              className={`px-4 py-3 rounded-lg border text-sm flex items-center justify-between gap-4 ${
                bannerMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              <span>{bannerMessage.text}</span>
              <button
                type="button"
                onClick={() => setBannerMessage(null)}
                aria-label="Zavřít oznámení"
                className="p-1 opacity-70 hover:opacity-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs font-medium text-slate-500">Evidovaní brokeři</div>
                  <div className="mt-2 font-mono text-2xl font-semibold text-slate-900">
                    {metrics.totalBrokers}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">GDPR · CCPA · Vlastní</div>
                </div>

                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs font-medium text-slate-500">Smazáno (Deleted)</div>
                  <div className="mt-2 font-mono text-2xl font-semibold text-emerald-700">
                    {metrics.deleted}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">Plánován re-check 60–90 dní</div>
                </div>

                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs font-medium text-slate-500">Probíhá řízení</div>
                  <div className="mt-2 font-mono text-2xl font-semibold text-blue-700">
                    {metrics.inProgress}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">Běží 30denní zákonná lhůta</div>
                </div>

                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs font-medium text-slate-500">Vyžaduje zásah</div>
                  <div className="mt-2 font-mono text-2xl font-semibold text-amber-700">
                    {metrics.actionRequired}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">CAPTCHA nebo ověření identity</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Plná moc k zastupování (GDPR čl. 17)
                    </h2>
                    <p className="text-sm text-slate-600 mt-1">
                      {userProfile?.poaSignedAt
                        ? `Elektronická plná moc podepsána dne ${new Date(
                            userProfile.poaSignedAt
                          ).toLocaleString('cs-CZ')}.`
                        : 'Udělte oprávnění k odesílání právních výzev jménem vašeho profilu datovým brokerům.'}
                    </p>
                  </div>
                  <div>
                    {userProfile?.poaSignedAt ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Oprávnění aktivní</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSignPoa()}
                        className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors"
                      >
                        Podepsat plnou moc
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Cyklovač & fronta úloh
                    </h2>
                    <p className="text-sm text-slate-600 mt-1">
                      Plánovač automaticky eskaluje žádosti po uplynutí 30denní lhůty, zpracovává backoff opakování a spouští re-výmazy po 60–90 dnech.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void handleSchedulerTick()}
                      className="px-4 py-2 text-sm font-medium text-slate-900 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
                    >
                      Zkontrolovat lhůty nyní
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('vault')}
                      className="px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900"
                    >
                      Spravovat trezor ({piiItems.length})
                    </button>
                  </div>
                </div>
              </div>

              {metrics.actionRequired > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 text-sm text-amber-900">
                    <ShieldAlert className="w-5 h-5 shrink-0" />
                    <span>
                      <strong>{metrics.actionRequired}</strong> žádostí vyžaduje váš zásah (např. CAPTCHA nebo ověření).
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('requests')}
                    className="px-3 py-1.5 text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded hover:bg-amber-100 whitespace-nowrap shrink-0"
                  >
                    Zobrazit žádosti
                  </button>
                </div>
              )}

              <div className="space-y-3">
                <h2 className="text-base font-semibold text-slate-900">Poslední žádosti o výmaz</h2>
                <RequestsTable
                  requests={requests.slice(0, 6)}
                  loading={dataLoading}
                  onStatusChange={handleStatusChange}
                  onDownloadPdf={handleDownloadPdf}
                  onDownloadEscalationPdf={handleDownloadEscalationPdf}
                  onRecordReply={handleRecordReply}
                  onLoadLogs={handleLoadLogs}
                />
              </div>
            </div>
          )}

          {activeTab === 'vault' && (
            <PiiVault
              items={piiItems}
              loading={dataLoading}
              accountEmail={userProfile?.email ?? session.email}
              onAdd={handleAddPii}
              onDelete={handleDeletePii}
            />
          )}

          {activeTab === 'requests' && (
            <RequestsTable
              requests={requests}
              loading={dataLoading}
              onStatusChange={handleStatusChange}
              onDownloadPdf={handleDownloadPdf}
              onDownloadEscalationPdf={handleDownloadEscalationPdf}
              onRecordReply={handleRecordReply}
              onLoadLogs={handleLoadLogs}
            />
          )}

          {activeTab === 'brokers' && (
            <BrokerDirectory
              brokers={brokers}
              loading={dataLoading}
              canLaunch={true}
              hasPii={piiItems.length > 0}
              launching={launching}
              onLaunch={handleLaunchRequests}
              onAddCustomBroker={handleAddCustomBroker}
            />
          )}

          {activeTab === 'settings' && (
            <SecuritySettings
              userProfile={userProfile}
              onRotateDek={handleRotateDek}
              onExportArchive={handleExportArchive}
              onShredAccount={handleShredAccount}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <DashboardShell />
    </AuthProvider>
  );
}
