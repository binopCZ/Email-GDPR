import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, MailPlus, Plus, Trash2 } from 'lucide-react';
import type { PiiItem, PiiType } from '../types/privacy.ts';

interface PiiVaultProps {
  items: PiiItem[];
  loading: boolean;
  accountEmail?: string;
  onAdd: (payload: { piiType: PiiType; value: string; profileLabel: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const PII_TYPE_LABELS: Record<PiiType, string> = {
  FULL_NAME: 'Celé jméno',
  EMAIL: 'Starý / osobní e-mail',
  PHONE: 'Telefonní číslo',
  ADDRESS: 'Adresa bydliště',
  DOB: 'Datum narození',
  ALT_NAME: 'Alternativní jméno / přezdívka',
};

function maskValue(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(10, value.length - 4))}${value.slice(-2)}`;
}

export function PiiVault({ items, loading, accountEmail, onAdd, onDelete }: PiiVaultProps) {
  const [piiType, setPiiType] = useState<PiiType>('FULL_NAME');
  const [value, setValue] = useState('');
  const [profileLabel, setProfileLabel] = useState('Primary');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});

  const hasAccountEmailInVault =
    Boolean(accountEmail) &&
    items.some(
      (i) => i.piiType === 'EMAIL' && i.value.trim().toLowerCase() === accountEmail!.toLowerCase()
    );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd({ piiType, value: value.trim(), profileLabel: profileLabel.trim() || 'Primary' });
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepodařilo se uložit údaj.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQuickAddAccountEmail() {
    if (!accountEmail) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd({ piiType: 'EMAIL', value: accountEmail, profileLabel: 'Primary' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepodařilo se uložit e-mail.');
    } finally {
      setSubmitting(false);
    }
  }

  function toggleReveal(id: string) {
    setRevealedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="space-y-8">
      {accountEmail && !hasAccountEmailInVault && (
        <div className="bg-white border border-slate-200 rounded-lg px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="text-sm text-slate-700">
            Chcete rovnou přidat váš přihlašovací e-mail{' '}
            <span className="font-mono font-medium text-slate-900">{accountEmail}</span> do seznamu údajů k výmazu?
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleQuickAddAccountEmail()}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <MailPlus className="w-3.5 h-3.5" />
            <span>Přidat můj e-mail do trezoru</span>
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-5 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Přidat údaj k automatickému výmazu
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Každý záznam je před zápisem zašifrován vaším klíčem (AES-256-GCM) a vyhledáván pouze přes slepý index.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 shrink-0">
            <Lock className="w-3.5 h-3.5" />
            <span>AES-256-GCM šifrování</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-3">
            <label htmlFor="pii-type" className="block text-xs font-medium text-slate-700 mb-1.5">
              Typ údaje
            </label>
            <select
              id="pii-type"
              value={piiType}
              onChange={(e) => setPiiType(e.target.value as PiiType)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              {Object.entries(PII_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-5">
            <label htmlFor="pii-value" className="block text-xs font-medium text-slate-700 mb-1.5">
              Hodnota k výmazu
            </label>
            <input
              id="pii-value"
              type="text"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                piiType === 'EMAIL'
                  ? 'jmeno@seznam.cz'
                  : piiType === 'PHONE'
                  ? '+420 777 123 456'
                  : 'Jan Novák'
              }
              className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="pii-label" className="block text-xs font-medium text-slate-700 mb-1.5">
              Štítek profilu
            </label>
            <input
              id="pii-label"
              type="text"
              value={profileLabel}
              onChange={(e) => setProfileLabel(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full h-10 px-4 inline-flex items-center justify-center gap-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>{submitting ? 'Šifruji...' : 'Přidat údaj'}</span>
            </button>
          </div>
        </form>

        {error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">
            Uložené identifikátory ({items.length})
          </h3>
          <span className="text-xs text-slate-500">
            Používá se při generování GDPR a CCPA žádostí
          </span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((idx) => (
              <div key={idx} className="h-10 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900">
              V trezoru zatím nemáte žádné osobní údaje
            </p>
            <p className="text-sm text-slate-500 mt-1">
              Přidejte své jméno, staré e-mailové adresy nebo telefonní čísla výše, abyste mohli spustit vlnu výmazů.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-6">Typ údaje</th>
                  <th className="py-2.5 px-4">Hodnota</th>
                  <th className="py-2.5 px-4">Profil</th>
                  <th className="py-2.5 px-4">Přidáno</th>
                  <th className="py-2.5 px-6 text-right">Akce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {items.map((item) => {
                  const isRevealed = Boolean(revealedIds[item.id]);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-6 font-medium text-slate-900 whitespace-nowrap">
                        {PII_TYPE_LABELS[item.piiType]}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-800">
                        {isRevealed ? item.value : maskValue(item.value)}
                      </td>
                      <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                        {item.profileLabel}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                        {new Date(item.createdAt).toLocaleDateString('cs-CZ')}
                      </td>
                      <td className="py-3 px-6 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleReveal(item.id)}
                            aria-label={isRevealed ? 'Skrýt hodnotu' : 'Zobrazit hodnotu'}
                            className="p-2 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 transition-colors"
                          >
                            {isRevealed ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDelete(item.id)}
                            aria-label="Smazat údaj"
                            className="p-2 text-slate-500 hover:text-red-600 rounded-md hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
