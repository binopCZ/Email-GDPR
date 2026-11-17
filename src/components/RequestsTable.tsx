import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileDown,
  History,
  MessageSquarePlus,
  RefreshCw,
  Scale,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { RemovalRequestItem, RemovalStatus, RequestLogItem } from '../types/privacy.ts';

interface RequestsTableProps {
  requests: RemovalRequestItem[];
  loading: boolean;
  onStatusChange: (id: string, status: RemovalStatus, note?: string) => Promise<void>;
  onDownloadPdf: (id: string, brokerSlug: string) => Promise<void>;
  onDownloadEscalationPdf: (id: string, brokerSlug: string) => Promise<void>;
  onRecordReply: (id: string, text: string) => Promise<void>;
  onLoadLogs: (id: string) => Promise<RequestLogItem[]>;
}

const STATUS_META: Record<
  RemovalStatus,
  { label: string; colorClass: string; icon: 'clock' | 'check' | 'warn' | 'alert' }
> = {
  PENDING: { label: 'Čeká', colorClass: 'text-slate-600', icon: 'clock' },
  QUEUED: { label: 'Ve frontě', colorClass: 'text-slate-600', icon: 'clock' },
  SENT: { label: 'Odesláno', colorClass: 'text-blue-700', icon: 'clock' },
  IN_REVIEW: { label: 'Zpracovává se', colorClass: 'text-blue-700', icon: 'clock' },
  ACTION_REQUIRED: { label: 'Vyžaduje zásah', colorClass: 'text-amber-700', icon: 'warn' },
  DELETED: { label: 'Smazáno', colorClass: 'text-emerald-700', icon: 'check' },
  REJECTED: { label: 'Zamítnuto', colorClass: 'text-red-700', icon: 'alert' },
  ESCALATED: { label: 'Eskalováno', colorClass: 'text-red-700', icon: 'alert' },
};

function StatusCell({ status }: { status: RemovalStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${meta.colorClass}`}>
      {meta.icon === 'check' && <CheckCircle2 className="w-3.5 h-3.5" />}
      {meta.icon === 'warn' && <ShieldAlert className="w-3.5 h-3.5" />}
      {meta.icon === 'alert' && <AlertCircle className="w-3.5 h-3.5" />}
      {meta.icon === 'clock' && <Clock className="w-3.5 h-3.5" />}
      <span>{meta.label}</span>
    </span>
  );
}

type FilterTab = 'ALL' | 'ACTIVE' | 'ACTION_REQUIRED' | 'DELETED' | 'ESCALATED';

export function RequestsTable({
  requests,
  loading,
  onStatusChange,
  onDownloadPdf,
  onDownloadEscalationPdf,
  onRecordReply,
  onLoadLogs,
}: RequestsTableProps) {
  const [filter, setFilter] = useState<FilterTab>('ALL');
  const [search, setSearch] = useState('');
  const [activeLogsReq, setActiveLogsReq] = useState<RemovalRequestItem | null>(null);
  const [logs, setLogs] = useState<RequestLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const [replyTarget, setReplyTarget] = useState<RemovalRequestItem | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySubmitting, setReplySubmitting] = useState(false);

  const filtered = useMemo(() => {
    return requests.filter((req) => {
      if (filter === 'ACTIVE' && !['PENDING', 'QUEUED', 'SENT', 'IN_REVIEW'].includes(req.status)) {
        return false;
      }
      if (filter === 'ACTION_REQUIRED' && req.status !== 'ACTION_REQUIRED') return false;
      if (filter === 'DELETED' && req.status !== 'DELETED') return false;
      if (filter === 'ESCALATED' && !['REJECTED', 'ESCALATED'].includes(req.status)) return false;

      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          req.broker.name.toLowerCase().includes(q) ||
          req.broker.domain.toLowerCase().includes(q) ||
          (req.aliasAddress?.toLowerCase().includes(q) ?? false)
        );
      }
      return true;
    });
  }, [requests, filter, search]);

  async function openLogsDrawer(reqItem: RemovalRequestItem) {
    setActiveLogsReq(reqItem);
    setLogsLoading(true);
    try {
      const data = await onLoadLogs(reqItem.id);
      setLogs(data);
    } finally {
      setLogsLoading(false);
    }
  }

  async function handleReplySubmit(e: FormEvent) {
    e.preventDefault();
    if (!replyTarget || !replyText.trim()) return;
    setReplySubmitting(true);
    try {
      await onRecordReply(replyTarget.id, replyText.trim());
      setReplyTarget(null);
      setReplyText('');
    } finally {
      setReplySubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md">
          {(
            [
              ['ALL', 'Vše'],
              ['ACTIVE', 'Aktivní'],
              ['ACTION_REQUIRED', 'Vyžaduje zásah'],
              ['DELETED', 'Smazáno'],
              ['ESCALATED', 'Eskalováno'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                filter === key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filtrovat podle brokera nebo aliasu..."
          className="h-9 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 w-full md:w-72"
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((idx) => (
              <div key={idx} className="h-10 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900">
              Žádné žádosti neodpovídají aktuálnímu filtru
            </p>
            <p className="text-sm text-slate-500 mt-1">
              Spusťte novou vlnu výmazů v sekci Registr brokerů.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-6">Broker / Subjekt</th>
                  <th className="py-2.5 px-4">Stav</th>
                  <th className="py-2.5 px-4">Izolovaný alias</th>
                  <th className="py-2.5 px-4">Lhůta / Re-cyklus</th>
                  <th className="py-2.5 px-6 text-right">Akce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-3 px-6">
                      <div className="font-medium text-slate-900">{item.broker.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {item.legalBasis === 'GDPR_ART_17' ? 'GDPR čl. 17' : 'CCPA § 1798.105'}
                        <span className="mx-1.5 text-slate-300" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-mono">Cyklus #{item.cycleNumber}</span>
                      </div>
                      {item.actionReasonDetail && (
                        <div className="text-xs text-amber-800 mt-1 max-w-md">
                          {item.actionReasonDetail}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <StatusCell status={item.status} />
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600">
                      {item.aliasAddress ?? '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap">
                      {item.status === 'DELETED' && item.nextCycleAt
                        ? `Re-výmaz ${new Date(item.nextCycleAt).toLocaleDateString('cs-CZ')}`
                        : item.deadlineAt
                        ? `SLA do ${new Date(item.deadlineAt).toLocaleDateString('cs-CZ')}`
                        : '—'}
                    </td>
                    <td className="py-3 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex flex-wrap justify-end items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void onDownloadPdf(item.id, item.broker.slug)}
                          title="Stáhnout právní PDF žádost"
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 inline-flex items-center gap-1 transition-colors"
                        >
                          <FileDown className="w-3.5 h-3.5" />
                          <span>PDF</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void openLogsDrawer(item)}
                          title="Zobrazit šifrovanou historii komunikace"
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 inline-flex items-center gap-1 transition-colors"
                        >
                          <History className="w-3.5 h-3.5" />
                          <span>Log</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setReplyTarget(item);
                            setReplyText('');
                          }}
                          title="Zaznamenat příchozí odpověď od brokera"
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 inline-flex items-center gap-1 transition-colors"
                        >
                          <MessageSquarePlus className="w-3.5 h-3.5" />
                          <span>Odpověď</span>
                        </button>

                        {item.status === 'ACTION_REQUIRED' && (
                          <button
                            type="button"
                            onClick={() =>
                              void onStatusChange(
                                item.id,
                                'SENT',
                                'Ruční potvrzení / CAPTCHA vyřešena uživatelem.'
                              )
                            }
                            className="px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 inline-flex items-center gap-1 transition-colors"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Potvrdit odeslání</span>
                          </button>
                        )}

                        {['SENT', 'IN_REVIEW', 'ACTION_REQUIRED'].includes(item.status) && (
                          <button
                            type="button"
                            onClick={() =>
                              void onStatusChange(
                                item.id,
                                'ESCALATED',
                                'Žádost eskalována pro přípravu podnětu na dozorový úřad (ÚOOÚ).'
                              )
                            }
                            className="px-2.5 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
                          >
                            Eskalovat
                          </button>
                        )}

                        {['ESCALATED', 'REJECTED'].includes(item.status) && (
                          <button
                            type="button"
                            onClick={() => void onDownloadEscalationPdf(item.id, item.broker.slug)}
                            className="px-2.5 py-1.5 text-xs font-medium text-white bg-red-700 rounded hover:bg-red-800 inline-flex items-center gap-1 transition-colors"
                          >
                            <Scale className="w-3.5 h-3.5" />
                            <span>Podnět ÚOOÚ</span>
                          </button>
                        )}

                        {item.status !== 'DELETED' && (
                          <button
                            type="button"
                            onClick={() =>
                              void onStatusChange(item.id, 'DELETED', 'Výmaz potvrzen brokerem.')
                            }
                            className="px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 transition-colors"
                          >
                            Označit Deleted
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal for recording/classifying an incoming broker reply */}
      {replyTarget && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={handleReplySubmit}
            className="w-full max-w-lg bg-white border border-slate-200 rounded-lg p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Zaznamenat odpověď — {replyTarget.broker.name}
              </h3>
              <button
                type="button"
                onClick={() => setReplyTarget(null)}
                aria-label="Zavřít"
                className="p-1.5 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              Vložte text odpovědi, která přišla na alias{' '}
              <span className="font-mono">{replyTarget.aliasAddress}</span>. Systém ji zašifruje a automaticky vyhodnotí výsledný stav.
            </p>
            <textarea
              required
              rows={5}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Např.: Potvrzujeme výmaz vašich osobních údajů z naší databáze..."
              className="w-full p-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReplyTarget(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md"
              >
                Zrušit
              </button>
              <button
                type="submit"
                disabled={replySubmitting}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50"
              >
                {replySubmitting ? 'Zpracovávám...' : 'Uložit a vyhodnotit'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Slide-over Audit Log Drawer */}
      {activeLogsReq && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex justify-end"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-xl bg-white h-full border-l border-slate-200 flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Auditní historie — {activeLogsReq.broker.name}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">
                  {activeLogsReq.aliasAddress}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveLogsReq(null)}
                aria-label="Zavřít"
                className="p-2 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {logsLoading ? (
                <div className="space-y-3">
                  <div className="h-20 bg-slate-100 rounded animate-pulse" />
                  <div className="h-20 bg-slate-100 rounded animate-pulse" />
                </div>
              ) : logs.length === 0 ? (
                <p className="text-sm text-slate-500">Zatím nejsou zaznamenány žádné události.</p>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="border border-slate-200 rounded-md p-4">
                    <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                      <span className="font-medium text-slate-900">
                        {log.eventType} ({log.channel})
                      </span>
                      <span className="font-mono">
                        {new Date(log.createdAt).toLocaleString('cs-CZ')}
                      </span>
                    </div>
                    {log.documentSha256 && (
                      <div className="text-xs font-mono text-slate-600 mb-2 break-all">
                        PDF SHA-256: {log.documentSha256}
                      </div>
                    )}
                    {log.payload && (
                      <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans bg-slate-50 p-3 rounded border border-slate-100">
                        {log.payload}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
