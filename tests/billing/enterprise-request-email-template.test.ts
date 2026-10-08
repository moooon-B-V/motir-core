import { describe, expect, it } from 'vitest';
import {
  enterpriseRequestReceivedEmail,
  type EnterpriseRequestReceivedEmailProps,
} from '@/lib/emailTemplates/enterpriseRequestReceived';
import { EMAIL_TEMPLATE_CLASS } from '@/lib/services/emailService';

// The staff email for a new Enterprise request (Story MOTIR-7602 · Subtask
// MOTIR-7606) — a pure template, rendered without I/O. It must name the org and
// the requester, list what they answered and leave out what they did not, link
// to the request in the console, and never carry a price.

const base: EnterpriseRequestReceivedEmailProps = {
  organizationName: 'Acme Robotics',
  requesterName: 'Ada Owner',
  requesterEmail: 'ada@acme.test',
  cardsPerDay: 40,
  parallelAgents: 6,
  agentPath: 'both',
  autonomy: 'autonomous_lead',
  startWhen: 'within_month',
  teamSize: 'size_51_200',
  contact: 'sales@acme.test',
  note: 'We would like a call next week.',
  requestUrl: 'https://app.test/admin/enterprise-requests/req_123',
};

describe('enterpriseRequestReceivedEmail', () => {
  it('names the org and requester, lists every answer, and links the request — in text and html', async () => {
    const email = await enterpriseRequestReceivedEmail(base);

    expect(email.subject).toBe('Enterprise request from Acme Robotics');
    for (const body of [email.text, email.html]) {
      expect(body).toContain('Acme Robotics');
      expect(body).toContain('Ada Owner');
      expect(body).toContain('ada@acme.test');
      expect(body).toContain('Work items a day: about 40');
      expect(body).toContain('Agents in parallel: 6');
      expect(body).toContain('Which agents: Both');
      expect(body).toContain('Run on its own: Run the project around the clock on its own');
      expect(body).toContain('When they would start: Within a month');
      expect(body).toContain('Team size: 51–200');
      expect(body).toContain('sales@acme.test');
      expect(body).toContain('We would like a call next week.');
      expect(body).toContain('https://app.test/admin/enterprise-requests/req_123');
    }
    // The link appears verbatim in the plain text (the dev-console contract).
    expect(email.text).toContain(
      'Open the request: https://app.test/admin/enterprise-requests/req_123',
    );
  });

  it('omits unanswered questions, and says so when every optional one is blank', async () => {
    const email = await enterpriseRequestReceivedEmail({
      ...base,
      cardsPerDay: null,
      parallelAgents: null,
      agentPath: null,
      autonomy: null,
      startWhen: null,
      teamSize: null,
    });
    expect(email.text).not.toContain('Work items a day');
    expect(email.text).not.toContain('Team size');
    expect(email.text).toContain('They left every optional question blank.');

    const partial = await enterpriseRequestReceivedEmail({ ...base, cardsPerDay: null });
    expect(partial.text).not.toContain('Work items a day');
    expect(partial.text).not.toContain('They left every optional question blank.');
  });

  it('carries no price', async () => {
    const email = await enterpriseRequestReceivedEmail(base);
    // The html's own markup (doctype, inline styles) is not copy, so it is held
    // to the word; the reader-facing subject and text to any currency too.
    for (const body of [email.subject, email.text]) {
      expect(body).not.toMatch(/[$€£¥]|\bprice\b|\bEUR\b|\bUSD\b/i);
    }
    expect(email.html).not.toMatch(/\bprice\b|[€£¥]/i);
  });

  it('renders in zh', async () => {
    const email = await enterpriseRequestReceivedEmail({ ...base, locale: 'zh' });
    expect(email.subject).toBe('Acme Robotics 的企业版咨询');
    expect(email.text).toContain('团队规模：51–200');
  });

  it('is essential mail — never held back by the notification budget', () => {
    expect(EMAIL_TEMPLATE_CLASS['enterprise-request-received']).toBe('essential');
  });
});
