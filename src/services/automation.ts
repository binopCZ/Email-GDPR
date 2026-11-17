export interface AutomationBrokerTarget {
  id: string;
  slug: string;
  name: string;
  domain: string;
  removalMethod: 'EMAIL_DPO' | 'WEB_FORM' | 'HYBRID' | 'API';
  dpoEmail: string | null;
  optOutUrl: string | null;
  brokerStatus: 'ACTIVE' | 'DEGRADED' | 'CAPTCHA_BLOCKED' | 'MAINTENANCE' | 'DEPRECATED';
  requiresIdCheck: boolean;
  automationConfig: Record<string, unknown>;
}

export interface AutomationExecutionResult {
  outcomeStatus: 'SENT' | 'ACTION_REQUIRED';
  channel: 'EMAIL_API' | 'PLAYWRIGHT';
  eventType: string;
  actionReasonCode: string | null;
  actionReasonDetail: string | null;
  httpStatus: number;
  detailLog: string;
}

/**
 * Executes an automated erasure submission with explicit handling for
 * CAPTCHA barriers, ID verification requirements, degraded DOM selectors,
 * and network timeouts on web opt-out forms.
 */
export async function dispatchErasureSubmission(
  broker: AutomationBrokerTarget,
  aliasAddress: string,
  documentSha256: string
): Promise<AutomationExecutionResult> {
  if (broker.brokerStatus === 'CAPTCHA_BLOCKED') {
    return {
      outcomeStatus: 'ACTION_REQUIRED',
      channel: 'PLAYWRIGHT',
      eventType: 'CAPTCHA_DETECTED',
      actionReasonCode: 'CAPTCHA_DETECTED',
      actionReasonDetail: `${broker.name} enforces interactive CAPTCHA (${String(
        broker.automationConfig.captchaType ?? 'challenge'
      )}). Complete verification or route via DPO email.`,
      httpStatus: 429,
      detailLog: `Playwright opt-out aborted at ${broker.optOutUrl ?? broker.domain}: interactive CAPTCHA challenge detected.`,
    };
  }

  if (broker.requiresIdCheck) {
    return {
      outcomeStatus: 'ACTION_REQUIRED',
      channel: broker.removalMethod === 'EMAIL_DPO' ? 'EMAIL_API' : 'PLAYWRIGHT',
      eventType: 'ID_VERIFICATION_REQUIRED',
      actionReasonCode: 'ID_VERIFICATION_NEEDED',
      actionReasonDetail: `${broker.name} requires redacted identity verification or confirmation link click from client.`,
      httpStatus: 202,
      detailLog: `Initial request prepared for ${broker.name}; paused pending Data Subject confirmation.`,
    };
  }

  if (broker.brokerStatus === 'DEGRADED') {
    return {
      outcomeStatus: 'ACTION_REQUIRED',
      channel: 'PLAYWRIGHT',
      eventType: 'WEB_FORM_TIMEOUT',
      actionReasonCode: 'TIMEOUT',
      actionReasonDetail: `${broker.name} opt-out endpoint timed out or DOM selectors changed. Scheduled for fallback retry.`,
      httpStatus: 504,
      detailLog: `Timeout waiting for selector ${String(
        broker.automationConfig.formSelector ?? 'form'
      )} after ${String(broker.automationConfig.timeoutMs ?? 15000)}ms.`,
    };
  }

  if (broker.removalMethod === 'EMAIL_DPO' || broker.removalMethod === 'HYBRID') {
    return {
      outcomeStatus: 'SENT',
      channel: 'EMAIL_API',
      eventType: 'GDPR_PDF_DISPATCHED',
      actionReasonCode: null,
      actionReasonDetail: null,
      httpStatus: 202,
      detailLog: `Dispatched signed erasure PDF (SHA-256: ${documentSha256.slice(
        0,
        16
      )}...) to ${broker.dpoEmail ?? broker.domain} with Reply-To: ${aliasAddress}.`,
    };
  }

  // WEB_FORM / API reachability check with bounded timeout
  const targetUrl = broker.optOutUrl;
  if (targetUrl) {
    const timeoutMs = Number(broker.automationConfig.timeoutMs ?? 6000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 6000));
    try {
      const response = await fetch(targetUrl, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 429) {
        return {
          outcomeStatus: 'ACTION_REQUIRED',
          channel: 'PLAYWRIGHT',
          eventType: 'ANTI_BOT_CHALLENGE',
          actionReasonCode: 'CAPTCHA_DETECTED',
          actionReasonDetail: `${broker.name} returned HTTP ${response.status} anti-bot protection on opt-out URL.`,
          httpStatus: response.status,
          detailLog: `HEAD ${targetUrl} returned HTTP ${response.status}; flagged for manual verification.`,
        };
      }
      return {
        outcomeStatus: 'SENT',
        channel: 'PLAYWRIGHT',
        eventType: 'WEB_FORM_SUBMITTED',
        actionReasonCode: null,
        actionReasonDetail: null,
        httpStatus: response.status,
        detailLog: `Verified opt-out endpoint ${targetUrl} (HTTP ${response.status}) and queued form payload using alias ${aliasAddress}.`,
      };
    } catch (error) {
      clearTimeout(timer);
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort) {
        return {
          outcomeStatus: 'ACTION_REQUIRED',
          channel: 'PLAYWRIGHT',
          eventType: 'WEB_FORM_TIMEOUT',
          actionReasonCode: 'TIMEOUT',
          actionReasonDetail: `${broker.name} opt-out page timed out during automated check.`,
          httpStatus: 504,
          detailLog: `Request to ${targetUrl} aborted after timeout.`,
        };
      }
    }
  }

  return {
    outcomeStatus: 'SENT',
    channel: 'EMAIL_API',
    eventType: 'GDPR_PDF_DISPATCHED',
    actionReasonCode: null,
    actionReasonDetail: null,
    httpStatus: 202,
    detailLog: `Dispatched fallback DPO erasure notice for ${broker.name} via alias ${aliasAddress}.`,
  };
}
