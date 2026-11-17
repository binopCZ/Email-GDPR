export type PiiType = 'FULL_NAME' | 'EMAIL' | 'PHONE' | 'ADDRESS' | 'DOB' | 'ALT_NAME';

export type RemovalStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'SENT'
  | 'IN_REVIEW'
  | 'ACTION_REQUIRED'
  | 'DELETED'
  | 'REJECTED'
  | 'ESCALATED';

export type LegalBasis = 'GDPR_ART_17' | 'CCPA_1798_105';

export interface UserProfile {
  id: string;
  email: string;
  subscriptionTier: 'FREE' | 'PRO' | 'FAMILY';
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION';
  poaSignedAt: string | null;
  kekVersion?: number;
  createdAt: string;
}

export interface PiiItem {
  id: string;
  piiType: PiiType;
  profileLabel: string;
  value: string;
  keyVersion: number;
  createdAt: string;
}

export interface Broker {
  id: string;
  slug: string;
  name: string;
  domain: string;
  jurisdiction: 'GDPR' | 'CCPA' | 'GLOBAL';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  removalMethod: 'EMAIL_DPO' | 'WEB_FORM' | 'HYBRID' | 'API';
  dpoEmail: string | null;
  optOutUrl: string | null;
  brokerStatus: 'ACTIVE' | 'DEGRADED' | 'CAPTCHA_BLOCKED' | 'MAINTENANCE' | 'DEPRECATED';
  legalSlaDays: number;
  recheckIntervalDays: number;
  requiresIdCheck: boolean;
  isCustom?: boolean;
}

export interface RemovalRequestItem {
  id: string;
  status: RemovalStatus;
  legalBasis: LegalBasis;
  cycleNumber: number;
  actionReasonCode: string | null;
  actionReasonDetail: string | null;
  retryCount: number;
  sentAt: string | null;
  deadlineAt: string | null;
  deletedAt: string | null;
  nextCycleAt: string | null;
  createdAt: string;
  updatedAt: string;
  aliasAddress: string | null;
  aliasStatus: 'ACTIVE' | 'PAUSED' | 'BURNED' | null;
  broker: Broker;
}

export interface RequestLogItem {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND' | 'SYSTEM';
  channel: string;
  eventType: string;
  documentSha256: string | null;
  httpStatus: number | null;
  createdAt: string;
  payload: string | null;
}
