import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { sha256Hex } from '../security/crypto.ts';

const DEJAVU_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const DEJAVU_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

export interface ErasureNoticeInput {
  requestId: string;
  legalBasis: 'GDPR_ART_17' | 'CCPA_1798_105';
  brokerName: string;
  brokerDomain: string;
  dpoEmail: string | null;
  aliasEmail: string;
  fullName: string;
  identifiers: Array<{ type: string; value: string }>;
  poaSignedAt: Date | null;
  issuedAt: Date;
}

export interface GeneratedErasurePdf {
  buffer: Buffer;
  sha256: string;
  plainTextSummary: string;
}

export async function generateErasureNoticePdf(
  input: ErasureNoticeInput
): Promise<GeneratedErasurePdf> {
  const isCzech = input.brokerDomain.endsWith('.cz') && input.legalBasis === 'GDPR_ART_17';

  const lawTitle = isCzech
    ? 'Žádost o výmaz osobních údajů (čl. 17 Nařízení GDPR)'
    : input.legalBasis === 'GDPR_ART_17'
    ? 'Formal Request for Erasure of Personal Data (GDPR Article 17)'
    : 'Consumer Request to Delete Personal Information (CCPA § 1798.105)';

  const identifierLines = input.identifiers.map((item) => `- ${item.type}: ${item.value}`);
  const plainTextSummary = isCzech
    ? [
        lawTitle,
        `Referenční ID: ${input.requestId}`,
        `Datum vystavení: ${input.issuedAt.toISOString()}`,
        `Adresát: Pověřenec pro ochranu osobních údajů / DPO (${input.brokerName} - ${input.brokerDomain})`,
        `Kontaktní alias pro odpověď: ${input.aliasEmail}`,
        '',
        `Subjekt údajů: ${input.fullName}`,
        'Identifikátory zahrnuté v žádosti:',
        ...identifierLines,
        '',
        'Na základě čl. 17 odst. 1 a čl. 12 odst. 3 Nařízení Evropského parlamentu a Rady (EU) 2016/679 (GDPR) žádáme o neprodlený výmaz všech osobních údajů a potvrzení o provedení výmazu do 30 kalendářních dnů na uvedenou aliasovou adresu.',
        input.poaSignedAt
          ? `Elektronická plná moc podepsána dne: ${input.poaSignedAt.toISOString()}`
          : 'Podáno v zastoupení ověřeného subjektu údajů.',
      ].join('\n')
    : [
        lawTitle,
        `Reference ID: ${input.requestId}`,
        `Issued: ${input.issuedAt.toISOString()}`,
        `Recipient: Data Protection Officer / Privacy Team (${input.brokerName} - ${input.brokerDomain})`,
        `Correspondence Alias: ${input.aliasEmail}`,
        '',
        `Data Subject: ${input.fullName}`,
        'Identifiers covered by this request:',
        ...identifierLines,
        '',
        input.legalBasis === 'GDPR_ART_17'
          ? 'Pursuant to Article 17(1) and Article 12(3) of Regulation (EU) 2016/679 (GDPR), we request immediate erasure of all personal data without undue delay and confirmation within 30 calendar days.'
          : 'Pursuant to California Civil Code § 1798.105 (CCPA/CPRA), we request permanent deletion of all personal information collected or sold and confirmation within the statutory response window.',
        input.poaSignedAt
          ? `Authorized Agent Power of Attorney signed at: ${input.poaSignedAt.toISOString()}`
          : 'Submitted on behalf of the verified data subject.',
      ].join('\n');

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: Error) => reject(err));

    const hasUnicodeFonts = fs.existsSync(DEJAVU_REGULAR) && fs.existsSync(DEJAVU_BOLD);
    if (hasUnicodeFonts) {
      doc.registerFont('Body', DEJAVU_REGULAR);
      doc.registerFont('Heading', DEJAVU_BOLD);
      doc.font('Body');
    }

    const setHeadingFont = () => {
      if (hasUnicodeFonts) doc.font('Heading');
    };
    const setBodyFont = () => {
      if (hasUnicodeFonts) doc.font('Body');
    };

    setHeadingFont();
    doc.fontSize(10).fillColor('#475569').text('PRIVAVAULT AUTOMATED PRIVACY COMPLIANCE NOTICE');
    doc.moveDown(0.5);
    doc.fontSize(15).fillColor('#0f172a').text(lawTitle);
    doc.moveDown(0.75);

    setBodyFont();
    doc.fontSize(10).fillColor('#334155');
    doc.text(`${isCzech ? 'Referenční ID' : 'Reference ID'}: ${input.requestId}`);
    doc.text(`${isCzech ? 'Datum vystavení' : 'Date Issued'}: ${input.issuedAt.toUTCString()}`);
    doc.text(`${isCzech ? 'Adresát' : 'Recipient'}: ${input.brokerName} (${input.brokerDomain})`);
    if (input.dpoEmail) {
      doc.text(`DPO / Privacy Contact: ${input.dpoEmail}`);
    }
    doc.text(
      `${isCzech ? 'Kontaktní alias pro odpověď' : 'Verified Correspondence Alias'}: ${input.aliasEmail}`
    );
    doc.moveDown(1);

    setHeadingFont();
    doc.fontSize(12).fillColor('#0f172a').text(
      isCzech ? '1. Identifikační údaje subjektu' : '1. Data Subject Identifiers'
    );
    doc.moveDown(0.35);
    setBodyFont();
    doc.fontSize(10).fillColor('#1e293b');
    doc.text(`${isCzech ? 'Jméno' : 'Full Name'}: ${input.fullName}`);
    for (const line of identifierLines) {
      doc.text(line);
    }
    doc.moveDown(1);

    setHeadingFont();
    doc.fontSize(12).fillColor('#0f172a').text(isCzech ? '2. Právní výzva' : '2. Statutory Demand');
    doc.moveDown(0.35);
    setBodyFont();
    doc.fontSize(10).fillColor('#1e293b').text(
      isCzech
        ? 'Jako pověřený zástupce výše uvedeného subjektu údajů tímto formálně uplatňujeme právo na výmaz („právo být zapomenut“) podle článku 17 Obecného nařízení o ochraně osobních údajů (EU) 2016/679 (GDPR). Žádáme o bezodkladné vymazání všech osobních údajů ze všech vašich databází, marketingových profilů a navazujících registrů a o písemné potvrzení na výše uvedenou aliasovou adresu nejpozději do 30 dnů dle čl. 12 odst. 3 GDPR.'
        : input.legalBasis === 'GDPR_ART_17'
        ? 'Acting as the authorized privacy representative of the above-named Data Subject, we formally exercise the Right to Erasure ("Right to be Forgotten") under Article 17 of the GDPR. You are required to erase all personal data concerning the Data Subject across all databases, people-search indexes, and downstream processors, and to confirm completion in writing to the correspondence alias above within one month (30 days) pursuant to Article 12(3) GDPR.'
        : 'Acting as the authorized agent of the above-named Consumer, we formally request deletion of all personal information pursuant to Cal. Civ. Code § 1798.105 (CCPA/CPRA). Please confirm permanent suppression and deletion to the correspondence alias above within the statutory deadline.',
      { align: 'left', lineGap: 3 }
    );
    doc.moveDown(1);

    setHeadingFont();
    doc.fontSize(12).fillColor('#0f172a').text(
      isCzech ? '3. Zmocnění a doručování' : '3. Authorization & Audit Integrity'
    );
    doc.moveDown(0.35);
    setBodyFont();
    doc.fontSize(10).fillColor('#475569').text(
      isCzech
        ? input.poaSignedAt
          ? `Elektronická plná moc podepsána subjektem údajů dne ${input.poaSignedAt.toISOString()}. Veškerou komunikaci směrujte výhradně na ${input.aliasEmail}.`
          : `Veškerou komunikaci směrujte výhradně na ${input.aliasEmail}.`
        : input.poaSignedAt
        ? `Power of Attorney digitally executed by the Data Subject at ${input.poaSignedAt.toISOString()}. Direct all replies exclusively to ${input.aliasEmail}.`
        : `Direct all replies exclusively to ${input.aliasEmail}.`
    );

    doc.end();
  });

  return {
    buffer,
    sha256: sha256Hex(buffer),
    plainTextSummary,
  };
}

export interface AuthorityComplaintInput {
  requestId: string;
  legalBasis: 'GDPR_ART_17' | 'CCPA_1798_105';
  brokerName: string;
  brokerDomain: string;
  dpoEmail: string | null;
  aliasEmail: string;
  fullName: string;
  sentAt: Date | null;
  deadlineAt: Date | null;
  originalPdfSha256: string | null;
  auditEvents: Array<{ createdAt: Date; eventType: string; detail: string }>;
}

export async function generateAuthorityComplaintPdf(
  input: AuthorityComplaintInput
): Promise<Buffer> {
  const isCzech = input.brokerDomain.endsWith('.cz') || input.legalBasis === 'GDPR_ART_17';

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: Error) => reject(err));

    const hasUnicodeFonts = fs.existsSync(DEJAVU_REGULAR) && fs.existsSync(DEJAVU_BOLD);
    if (hasUnicodeFonts) {
      doc.registerFont('Body', DEJAVU_REGULAR);
      doc.registerFont('Heading', DEJAVU_BOLD);
      doc.font('Body');
    }

    const setHeading = () => {
      if (hasUnicodeFonts) doc.font('Heading');
    };
    const setBody = () => {
      if (hasUnicodeFonts) doc.font('Body');
    };

    setHeading();
    doc.fontSize(10).fillColor('#991b1b').text('ESKALAČNÍ PODNĚT DOZOROVÉMU ÚŘADU');
    doc.moveDown(0.5);
    doc.fontSize(15).fillColor('#0f172a').text(
      isCzech
        ? 'Podnět k prošetření porušení práva na výmaz (čl. 17 a čl. 77 GDPR)'
        : 'Formal Supervisory Authority Complaint — Failure to Comply with Erasure Request'
    );
    doc.moveDown(0.75);

    setBody();
    doc.fontSize(10).fillColor('#334155');
    if (isCzech) {
      doc.text('Adresát: Úřad pro ochranu osobních údajů (ÚOOÚ), Pplk. Sochora 27, 170 00 Praha 7');
    } else {
      doc.text('Recipient: Competent Data Protection Supervisory Authority / California Privacy Protection Agency');
    }
    doc.text(`Referenční ID případu: ${input.requestId}`);
    doc.text(`Stěžovatel (subjekt údajů): ${input.fullName}`);
    doc.text(`Kontaktní adresa pro doručování (alias): ${input.aliasEmail}`);
    doc.moveDown(0.75);

    setHeading();
    doc.fontSize(12).fillColor('#0f172a').text('1. Identifikace správce údajů');
    doc.moveDown(0.35);
    setBody();
    doc.fontSize(10).fillColor('#1e293b');
    doc.text(`Subjekt: ${input.brokerName} (${input.brokerDomain})`);
    if (input.dpoEmail) {
      doc.text(`Kontakt na pověřence (DPO): ${input.dpoEmail}`);
    }
    doc.moveDown(0.75);

    setHeading();
    doc.fontSize(12).fillColor('#0f172a').text('2. Popis porušení zákonné lhůty');
    doc.moveDown(0.35);
    setBody();
    doc.fontSize(10).fillColor('#1e293b').text(
      `Dne ${
        input.sentAt ? input.sentAt.toISOString() : 'neuvedeno'
      } byla výše uvedenému správci prokazatelně doručena formální žádost o výmaz osobních údajů podle ${
        input.legalBasis === 'GDPR_ART_17' ? 'čl. 17 GDPR' : 'CCPA § 1798.105'
      }. Zákonná 30denní lhůta pro vyjádření a provedení výmazu (čl. 12 odst. 3 GDPR) uplynula dne ${
        input.deadlineAt ? input.deadlineAt.toISOString() : 'neuvedeno'
      } bez řádného splnění povinnosti.`,
      { lineGap: 3 }
    );
    if (input.originalPdfSha256) {
      doc.moveDown(0.35);
      doc.text(`Kryptografický otisk původní výzvy (SHA-256): ${input.originalPdfSha256}`);
    }
    doc.moveDown(0.75);

    setHeading();
    doc.fontSize(12).fillColor('#0f172a').text('3. Chronologická auditní stopa');
    doc.moveDown(0.35);
    setBody();
    doc.fontSize(9).fillColor('#334155');
    for (const ev of input.auditEvents.slice(0, 12)) {
      doc.text(`[${ev.createdAt.toISOString()}] ${ev.eventType}: ${ev.detail.slice(0, 260)}`);
      doc.moveDown(0.25);
    }

    doc.end();
  });
}
