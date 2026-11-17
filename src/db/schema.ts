import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Custom BYTEA type mapped directly to Node.js Buffer
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// Enums
export const subscriptionTierEnum = pgEnum('subscription_tier', ['FREE', 'PRO', 'FAMILY']);
export const accountStatusEnum = pgEnum('account_status', ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION']);
export const piiTypeEnum = pgEnum('pii_type', [
  'FULL_NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'DOB',
  'ALT_NAME',
]);
export const jurisdictionEnum = pgEnum('jurisdiction_type', ['GDPR', 'CCPA', 'GLOBAL']);
export const riskLevelEnum = pgEnum('risk_level', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const removalMethodEnum = pgEnum('removal_method', [
  'EMAIL_DPO',
  'WEB_FORM',
  'HYBRID',
  'API',
]);
export const brokerStatusEnum = pgEnum('broker_status', [
  'ACTIVE',
  'DEGRADED',
  'CAPTCHA_BLOCKED',
  'MAINTENANCE',
  'DEPRECATED',
]);
export const legalBasisEnum = pgEnum('legal_basis_type', ['GDPR_ART_17', 'CCPA_1798_105']);
export const removalStatusEnum = pgEnum('removal_status', [
  'PENDING',
  'QUEUED',
  'SENT',
  'IN_REVIEW',
  'ACTION_REQUIRED',
  'DELETED',
  'REJECTED',
  'ESCALATED',
]);
export const aliasStatusEnum = pgEnum('alias_status', ['ACTIVE', 'PAUSED', 'BURNED']);
export const logDirectionEnum = pgEnum('log_direction', ['OUTBOUND', 'INBOUND', 'SYSTEM']);
export const jobTypeEnum = pgEnum('job_type', ['EMAIL_DISPATCH', 'WEB_FORM_AUTOMATION', 'RECHECK']);
export const jobStatusEnum = pgEnum('job_status', [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'RETRY_WAIT',
  'FAILED',
]);

// 1. Users table (linked to Firebase Auth UID + envelope encryption DEK)
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  uid: text('uid').notNull().unique(),
  emailBlindIdx: char('email_blind_idx', { length: 64 }).notNull().unique(),
  emailCiphertext: bytea('email_ciphertext').notNull(),
  emailIv: bytea('email_iv').notNull(),
  emailAuthTag: bytea('email_auth_tag').notNull(),
  passwordHash: text('password_hash'),

  dekCiphertext: bytea('dek_ciphertext').notNull(),
  dekIv: bytea('dek_iv').notNull(),
  dekAuthTag: bytea('dek_auth_tag').notNull(),
  kekVersion: smallint('kek_version').notNull().default(1),

  subscriptionTier: subscriptionTierEnum('subscription_tier').notNull().default('FREE'),
  accountStatus: accountStatusEnum('account_status').notNull().default('ACTIVE'),

  poaSignedAt: timestamp('poa_signed_at', { withTimezone: true }),
  poaIpHash: char('poa_ip_hash', { length: 64 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 2. User PII table (AES-256-GCM encrypted personal identifiers)
export const userPii = pgTable(
  'user_pii',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    piiType: piiTypeEnum('pii_type').notNull(),
    profileLabel: varchar('profile_label', { length: 50 }).notNull().default('Primary'),

    valueCiphertext: bytea('value_ciphertext').notNull(),
    valueIv: bytea('value_iv').notNull(),
    valueAuthTag: bytea('value_auth_tag').notNull(),
    valueBlindIdx: char('value_blind_idx', { length: 64 }).notNull(),
    keyVersion: smallint('key_version').notNull().default(1),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_pii_user_active').on(table.userId).where(sql`${table.isActive} = true`),
    uniqueIndex('uq_user_pii_blind').on(table.userId, table.piiType, table.valueBlindIdx),
  ]
);

// 3. Data brokers registry table (global catalog + user-added custom entities)
export const brokers = pgTable(
  'brokers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: varchar('slug', { length: 120 }).notNull().unique(),
    name: varchar('name', { length: 150 }).notNull(),
    domain: varchar('domain', { length: 255 }).notNull(),
    jurisdiction: jurisdictionEnum('jurisdiction').notNull().default('GLOBAL'),
    riskLevel: riskLevelEnum('risk_level').notNull().default('MEDIUM'),
    removalMethod: removalMethodEnum('removal_method').notNull(),

    dpoEmail: varchar('dpo_email', { length: 255 }),
    optOutUrl: text('opt_out_url'),
    automationConfig: jsonb('automation_config').$type<Record<string, unknown>>().notNull().default({}),
    brokerStatus: brokerStatusEnum('broker_status').notNull().default('ACTIVE'),

    legalSlaDays: smallint('legal_sla_days').notNull().default(30),
    recheckIntervalDays: smallint('recheck_interval_days').notNull().default(75),
    requiresIdCheck: boolean('requires_id_check').notNull().default(false),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),

    isCustom: boolean('is_custom').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_brokers_active').on(table.brokerStatus).where(sql`${table.brokerStatus} = 'ACTIVE'`),
    uniqueIndex('uq_brokers_global_domain')
      .on(table.domain)
      .where(sql`${table.createdByUserId} IS NULL`),
    uniqueIndex('uq_brokers_custom_domain')
      .on(table.createdByUserId, table.domain)
      .where(sql`${table.createdByUserId} IS NOT NULL`),
  ]
);

// 4. Isolated per-broker alias mailboxes
export const aliasMailboxes = pgTable(
  'alias_mailboxes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    brokerId: uuid('broker_id')
      .notNull()
      .references(() => brokers.id, { onDelete: 'restrict' }),
    aliasAddress: varchar('alias_address', { length: 255 }).notNull().unique(),
    status: aliasStatusEnum('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    burnedAt: timestamp('burned_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('uq_alias_user_broker').on(table.userId, table.brokerId)]
);

// 5. Removal requests tracking statuses, 30-day SLA, and 60-90 day re-cycles
export const removalRequests = pgTable(
  'removal_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    piiId: uuid('pii_id').references(() => userPii.id, { onDelete: 'set null' }),
    brokerId: uuid('broker_id')
      .notNull()
      .references(() => brokers.id, { onDelete: 'restrict' }),
    aliasId: uuid('alias_id').references(() => aliasMailboxes.id, { onDelete: 'set null' }),

    legalBasis: legalBasisEnum('legal_basis').notNull().default('GDPR_ART_17'),
    status: removalStatusEnum('status').notNull().default('PENDING'),
    cycleNumber: integer('cycle_number').notNull().default(1),

    actionReasonCode: varchar('action_reason_code', { length: 64 }),
    actionReasonDetail: text('action_reason_detail'),
    retryCount: smallint('retry_count').notNull().default(0),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    nextCycleAt: timestamp('next_cycle_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_removal_user_broker').on(table.userId, table.brokerId),
    index('idx_removal_user_status').on(table.userId, table.status),
    index('idx_removal_sla_watch')
      .on(table.deadlineAt)
      .where(sql`${table.status} IN ('SENT', 'IN_REVIEW')`),
    index('idx_removal_recheck_watch')
      .on(table.nextCycleAt)
      .where(sql`${table.status} = 'DELETED'`),
  ]
);

// 6. Encrypted request audit logs
export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => removalRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    direction: logDirectionEnum('direction').notNull(),
    channel: varchar('channel', { length: 32 }).notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),

    payloadEnc: bytea('payload_enc'),
    payloadIv: bytea('payload_iv'),
    payloadTag: bytea('payload_tag'),

    documentSha256: char('document_sha256', { length: 64 }),
    httpStatus: smallint('http_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_request_logs_req').on(table.requestId, table.createdAt)]
);

// 7. Async automation worker job queue with exponential backoff retries
export const automationJobs = pgTable(
  'automation_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => removalRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    brokerId: uuid('broker_id')
      .notNull()
      .references(() => brokers.id, { onDelete: 'cascade' }),

    jobType: jobTypeEnum('job_type').notNull(),
    status: jobStatusEnum('status').notNull().default('QUEUED'),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(3),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_jobs_ready')
      .on(table.nextRunAt)
      .where(sql`${table.status} IN ('QUEUED', 'RETRY_WAIT')`),
  ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  piiRecords: many(userPii),
  aliases: many(aliasMailboxes),
  removalRequests: many(removalRequests),
  customBrokers: many(brokers),
}));

export const userPiiRelations = relations(userPii, ({ one }) => ({
  user: one(users, { fields: [userPii.userId], references: [users.id] }),
}));

export const brokersRelations = relations(brokers, ({ one, many }) => ({
  createdBy: one(users, { fields: [brokers.createdByUserId], references: [users.id] }),
  aliases: many(aliasMailboxes),
  removalRequests: many(removalRequests),
}));

export const aliasMailboxesRelations = relations(aliasMailboxes, ({ one }) => ({
  user: one(users, { fields: [aliasMailboxes.userId], references: [users.id] }),
  broker: one(brokers, { fields: [aliasMailboxes.brokerId], references: [brokers.id] }),
}));

export const removalRequestsRelations = relations(removalRequests, ({ one, many }) => ({
  user: one(users, { fields: [removalRequests.userId], references: [users.id] }),
  pii: one(userPii, { fields: [removalRequests.piiId], references: [userPii.id] }),
  broker: one(brokers, { fields: [removalRequests.brokerId], references: [brokers.id] }),
  alias: one(aliasMailboxes, { fields: [removalRequests.aliasId], references: [aliasMailboxes.id] }),
  logs: many(requestLogs),
  jobs: many(automationJobs),
}));

export const requestLogsRelations = relations(requestLogs, ({ one }) => ({
  request: one(removalRequests, {
    fields: [requestLogs.requestId],
    references: [removalRequests.id],
  }),
  user: one(users, { fields: [requestLogs.userId], references: [users.id] }),
}));

export const automationJobsRelations = relations(automationJobs, ({ one }) => ({
  request: one(removalRequests, {
    fields: [automationJobs.requestId],
    references: [removalRequests.id],
  }),
  user: one(users, { fields: [automationJobs.userId], references: [users.id] }),
  broker: one(brokers, { fields: [automationJobs.brokerId], references: [brokers.id] }),
}));
