export interface OutboundEmailInput {
  to: string;
  replyTo: string;
  subject: string;
  textBody: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
}

export interface EmailDispatchResult {
  provider: 'RESEND' | 'SENDGRID' | 'DRY_RUN';
  delivered: boolean;
  providerMessageId: string | null;
  httpStatus: number;
  detail: string;
}

export async function sendErasureEmail(input: OutboundEmailInput): Promise<EmailDispatchResult> {
  const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'privacy@privavault.local';
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const sendgridKey = process.env.SENDGRID_API_KEY?.trim();

  if (resendKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [input.to],
        reply_to: input.replyTo,
        subject: input.subject,
        text: input.textBody,
        attachments: [
          {
            filename: input.pdfFilename,
            content: input.pdfBuffer.toString('base64'),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Resend API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { id?: string };
    return {
      provider: 'RESEND',
      delivered: true,
      providerMessageId: data.id ?? null,
      httpStatus: response.status,
      detail: `Email dispatched via Resend (ID: ${data.id ?? 'n/a'}) to ${input.to} with Reply-To: ${input.replyTo}.`,
    };
  }

  if (sendgridKey) {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }], subject: input.subject }],
        from: { email: fromAddress },
        reply_to: { email: input.replyTo },
        content: [{ type: 'text/plain', value: input.textBody }],
        attachments: [
          {
            content: input.pdfBuffer.toString('base64'),
            filename: input.pdfFilename,
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`SendGrid API error (${response.status}): ${errText}`);
    }

    const msgId = response.headers.get('x-message-id');
    return {
      provider: 'SENDGRID',
      delivered: true,
      providerMessageId: msgId,
      httpStatus: response.status,
      detail: `Email dispatched via SendGrid (ID: ${msgId ?? 'n/a'}) to ${input.to} with Reply-To: ${input.replyTo}.`,
    };
  }

  return {
    provider: 'DRY_RUN',
    delivered: false,
    providerMessageId: null,
    httpStatus: 202,
    detail: `Prepared GDPR/CCPA email with PDF (${input.pdfFilename}) for ${input.to} (Reply-To: ${input.replyTo}). Configure RESEND_API_KEY or SENDGRID_API_KEY for live SMTP/API delivery.`,
  };
}
