import { useState } from 'react';
import { Download, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';
import type { UserProfile } from '../types/privacy.ts';

interface SecuritySettingsProps {
  userProfile: UserProfile | null;
  onRotateDek: () => Promise<void>;
  onExportArchive: () => Promise<void>;
  onShredAccount: () => Promise<void>;
}

export function SecuritySettings({
  userProfile,
  onRotateDek,
  onExportArchive,
  onShredAccount,
}: SecuritySettingsProps) {
  const [rotating, setRotating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmShred, setConfirmShred] = useState(false);
  const [shredding, setShredding] = useState(false);

  async function handleRotate() {
    setRotating(true);
    try {
      await onRotateDek();
    } finally {
      setRotating(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      await onExportArchive();
    } finally {
      setExporting(false);
    }
  }

  async function handleShred() {
    setShredding(true);
    try {
      await onShredAccount();
    } finally {
      setShredding(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Rotace osobního šifrovacího klíče (DEK)
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Vygeneruje nový 256bitový klíč AES-256-GCM a atomicky přešifruje všechny uložené osobní údaje i auditní logy. Aktuální verze klíče:{' '}
            <span className="font-mono font-medium text-slate-900">
              v{userProfile?.kekVersion ?? 1}
            </span>
          </p>
        </div>
        <button
          type="button"
          disabled={rotating}
          onClick={() => void handleRotate()}
          className="px-4 py-2 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
        >
          <KeyRound className="w-3.5 h-3.5" />
          <span>{rotating ? 'Přegenerovávám...' : 'Rotovat DEK klíč'}</span>
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Export kompletního GDPR archivu (.zip)
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Stáhne podepsaný manifest, dešifrovaný přehled vašeho trezoru, všechna vygenerovaná PDF a kompletní historii komunikace s brokery.
          </p>
        </div>
        <button
          type="button"
          disabled={exporting}
          onClick={() => void handleExport()}
          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>{exporting ? 'Připravuji ZIP...' : 'Stáhnout GDPR archiv (.zip)'}</span>
        </button>
      </div>

      <div className="bg-white border border-red-200 rounded-lg p-6 space-y-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-red-700 mt-0.5 shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-red-900">
              Kryptografická skartace účtu (Crypto-shredding)
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Trvale zničí váš šifrovací klíč DEK a smaže všechny osobní údaje, izolované aliasy, žádosti, vlastní subjekty i auditní záznamy z databáze. Tato akce je nevratná.
            </p>
          </div>
        </div>

        {!confirmShred ? (
          <button
            type="button"
            onClick={() => setConfirmShred(true)}
            className="px-4 py-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 inline-flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Smazat účet a zničit šifrovací klíče</span>
          </button>
        ) : (
          <div className="p-4 bg-red-50 border border-red-200 rounded-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span className="text-xs font-medium text-red-900">
              Opravdu chcete nevratně zničit celý trezor a všechna data?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmShred(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded"
              >
                Zrušit
              </button>
              <button
                type="button"
                disabled={shredding}
                onClick={() => void handleShred()}
                className="px-3 py-1.5 text-xs font-medium text-white bg-red-700 rounded hover:bg-red-800 disabled:opacity-50"
              >
                {shredding ? 'Skartuji...' : 'Ano, trvale smazat vše'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
