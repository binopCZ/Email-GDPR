import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Mail,
  Plus,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { Broker, LegalBasis } from '../types/privacy.ts';

interface BrokerDirectoryProps {
  brokers: Broker[];
  loading: boolean;
  canLaunch: boolean;
  hasPii: boolean;
  launching: boolean;
  onLaunch: (brokerIds: string[], legalBasis: LegalBasis) => Promise<void>;
  onAddCustomBroker?: (payload: {
    name: string;
    domain: string;
    dpoEmail: string;
    jurisdiction: 'GDPR' | 'CCPA' | 'GLOBAL';
  }) => Promise<void>;
}

const METHOD_LABEL: Record<Broker['removalMethod'], string> = {
  EMAIL_DPO: 'DPO e-mail',
  WEB_FORM: 'Web formulář',
  HYBRID: 'Hybridní',
  API: 'API',
};

function renderBrokerStatus(status: Broker['brokerStatus']) {
  switch (status) {
    case 'ACTIVE':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Aktivní</span>
        </span>
      );
    case 'CAPTCHA_BLOCKED':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>CAPTCHA</span>
        </span>
      );
    case 'DEGRADED':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Zhoršená dostupnost</span>
        </span>
      );
    default:
      return <span className="text-xs text-slate-500">{status}</span>;
  }
}

export function BrokerDirectory({
  brokers,
  loading,
  canLaunch,
  hasPii,
  launching,
  onLaunch,
  onAddCustomBroker,
}: BrokerDirectoryProps) {
  const [jurisdictionFilter, setJurisdictionFilter] = useState<'ALL' | 'GDPR' | 'CCPA' | 'GLOBAL'>(
    'ALL'
  );
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [legalBasis, setLegalBasis] = useState<LegalBasis>('GDPR_ART_17');

  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customDomain, setCustomDomain] = useState('');
  const [customDpoEmail, setCustomDpoEmail] = useState('');
  const [customJurisdiction, setCustomJurisdiction] = useState<'GDPR' | 'CCPA' | 'GLOBAL'>('GDPR');
  const [customSubmitting, setCustomSubmitting] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return brokers.filter((b) => {
      if (jurisdictionFilter !== 'ALL' && b.jurisdiction !== jurisdictionFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return b.name.toLowerCase().includes(q) || b.domain.toLowerCase().includes(q);
      }
      return true;
    });
  }, [brokers, jurisdictionFilter, search]);

  const selectedList = useMemo(
    () => Object.entries(selectedIds).filter(([, checked]) => checked).map(([id]) => id),
    [selectedIds]
  );

  function toggleAllVisible() {
    const allSelected = filtered.length > 0 && filtered.every((b) => selectedIds[b.id]);
    if (allSelected) {
      const next = { ...selectedIds };
      for (const b of filtered) delete next[b.id];
      setSelectedIds(next);
    } else {
      const next = { ...selectedIds };
      for (const b of filtered) next[b.id] = true;
      setSelectedIds(next);
    }
  }

  async function handleCustomSubmit(e: FormEvent) {
    e.preventDefault();
    if (!onAddCustomBroker) return;
    setCustomSubmitting(true);
    setCustomError(null);
    try {
      await onAddCustomBroker({
        name: customName.trim(),
        domain: customDomain.trim(),
        dpoEmail: customDpoEmail.trim(),
        jurisdiction: customJurisdiction,
      });
      setCustomName('');
      setCustomDomain('');
      setCustomDpoEmail('');
      setShowCustomForm(false);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : 'Nepodařilo se přidat subjekt.');
    } finally {
      setCustomSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(['ALL', 'GDPR', 'CCPA', 'GLOBAL'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setJurisdictionFilter(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  jurisdictionFilter === tab
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab === 'ALL' ? 'Všechny' : tab}
              </button>
            ))}
          </div>

          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Hledat brokera nebo doménu..."
            className="h-9 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 w-64"
          />
        </div>

        {canLaunch && (
          <div className="flex flex-wrap items-center gap-3">
            {onAddCustomBroker && (
              <button
                type="button"
                onClick={() => setShowCustomForm((prev) => !prev)}
                className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                {showCustomForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                <span>Přidat vlastní firmu / e-shop</span>
              </button>
            )}

            <select
              aria-label="Právní základ"
              value={legalBasis}
              onChange={(e) => setLegalBasis(e.target.value as LegalBasis)}
              className="h-9 px-3 text-xs font-medium bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value="GDPR_ART_17">GDPR čl. 17 (EU/EHP)</option>
              <option value="CCPA_1798_105">CCPA § 1798.105 (USA)</option>
            </select>

            <button
              type="button"
              disabled={!hasPii || launching}
              onClick={() =>
                void onLaunch(
                  selectedList.length > 0 ? selectedList : filtered.map((b) => b.id),
                  legalBasis
                )
              }
              className="h-9 px-4 inline-flex items-center gap-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>
                {launching
                  ? 'Odesílám žádosti...'
                  : selectedList.length > 0
                  ? `Odeslat na vybrané (${selectedList.length})`
                  : `Odeslat na všechny (${filtered.length})`}
              </span>
            </button>
          </div>
        )}
      </div>

      {showCustomForm && onAddCustomBroker && (
        <form
          onSubmit={handleCustomSubmit}
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Přidat vlastní firmu, portál nebo e-shop k výmazu
            </h3>
            <button
              type="button"
              onClick={() => setShowCustomForm(false)}
              className="text-xs text-slate-500 hover:text-slate-900"
            >
              Zavřít
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-3">
              <label htmlFor="custom-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                Název subjektu
              </label>
              <input
                id="custom-name"
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Alza.cz / Můj E-shop"
                className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900"
              />
            </div>
            <div className="md:col-span-3">
              <label htmlFor="custom-domain" className="block text-xs font-medium text-slate-700 mb-1.5">
                Doména
              </label>
              <input
                id="custom-domain"
                type="text"
                required
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="alza.cz"
                className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900"
              />
            </div>
            <div className="md:col-span-3">
              <label htmlFor="custom-dpo" className="block text-xs font-medium text-slate-700 mb-1.5">
                DPO / GDPR e-mail
              </label>
              <input
                id="custom-dpo"
                type="email"
                required
                value={customDpoEmail}
                onChange={(e) => setCustomDpoEmail(e.target.value)}
                placeholder="dpo@alza.cz"
                className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900"
              />
            </div>
            <div className="md:col-span-1">
              <label htmlFor="custom-jur" className="block text-xs font-medium text-slate-700 mb-1.5">
                Právo
              </label>
              <select
                id="custom-jur"
                value={customJurisdiction}
                onChange={(e) =>
                  setCustomJurisdiction(e.target.value as 'GDPR' | 'CCPA' | 'GLOBAL')
                }
                className="w-full h-10 px-2 text-xs bg-white border border-slate-300 rounded-md text-slate-900"
              >
                <option value="GDPR">GDPR</option>
                <option value="CCPA">CCPA</option>
                <option value="GLOBAL">Global</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={customSubmitting}
                className="w-full h-10 px-4 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                {customSubmitting ? 'Ukládám...' : 'Uložit subjekt'}
              </button>
            </div>
          </div>
          {customError && <p className="text-xs text-red-600">{customError}</p>}
        </form>
      )}

      {canLaunch && !hasPii && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          Nejdříve přidejte alespoň jeden osobní údaj v sekci <strong>Trezor údajů</strong>, poté můžete odeslat žádosti o výmaz.
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((idx) => (
              <div key={idx} className="h-10 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  {canLaunch && (
                    <th className="py-2.5 pl-6 pr-2 w-10">
                      <input
                        type="checkbox"
                        aria-label="Vybrat všechny brokery"
                        checked={
                          filtered.length > 0 && filtered.every((b) => Boolean(selectedIds[b.id]))
                        }
                        onChange={toggleAllVisible}
                        className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                      />
                    </th>
                  )}
                  <th className="py-2.5 px-4">Data Broker / Portál</th>
                  <th className="py-2.5 px-4">Jurisdikce & Riziko</th>
                  <th className="py-2.5 px-4">Metoda / DPO</th>
                  <th className="py-2.5 px-4">Lhůta / Cyklus</th>
                  <th className="py-2.5 px-6 text-right">Stav konektoru</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((broker) => (
                  <tr key={broker.id} className="hover:bg-slate-50 transition-colors">
                    {canLaunch && (
                      <td className="py-3 pl-6 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`Vybrat ${broker.name}`}
                          checked={Boolean(selectedIds[broker.id])}
                          onChange={(e) =>
                            setSelectedIds((prev) => ({ ...prev, [broker.id]: e.target.checked }))
                          }
                          className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                        />
                      </td>
                    )}
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">
                        {broker.name}
                        {broker.isCustom && (
                          <span className="ml-2 text-xs font-normal text-slate-500">
                            · Vlastní subjekt
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                        <Globe className="w-3 h-3" />
                        <span>{broker.domain}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                      <span>{broker.jurisdiction}</span>
                      <span className="mx-1.5 text-slate-300" aria-hidden="true">
                        ·
                      </span>
                      <span
                        className={
                          broker.riskLevel === 'CRITICAL'
                            ? 'text-red-700 font-medium'
                            : broker.riskLevel === 'HIGH'
                            ? 'text-amber-700 font-medium'
                            : 'text-slate-600'
                        }
                      >
                        Riziko: {broker.riskLevel}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">
                      <div className="font-medium text-slate-900">
                        {METHOD_LABEL[broker.removalMethod]}
                      </div>
                      {broker.dpoEmail && (
                        <div className="text-slate-500 flex items-center gap-1 mt-0.5 font-mono">
                          <Mail className="w-3 h-3 shrink-0" />
                          <span className="truncate max-w-[200px]">{broker.dpoEmail}</span>
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap">
                      {broker.legalSlaDays}d SLA / {broker.recheckIntervalDays}d cyklus
                    </td>
                    <td className="py-3 px-6 text-right whitespace-nowrap">
                      {renderBrokerStatus(broker.brokerStatus)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
