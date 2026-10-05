import { EMAIL_CLASS, type EmailData, type EmailLinks, type EmailTemplate } from '@remoa/contracts';
import { emailExamples, emailLinksExample } from '@remoa/contracts/mocks';

// Fictional data (contracts mocks): /dev/emails, emails:test and the render tests.
export const emailSamples: { template: EmailTemplate; version: string }[] = emailExamples.map(({ template, version }) => ({ template, version }));

export function sampleData<T extends EmailTemplate>(template: T, version = 'default'): EmailData<T> {
  const e = emailExamples.find((x) => x.template === template && x.version === version) ?? emailExamples.find((x) => x.template === template);
  if (!e) throw new Error(`unknown template: ${String(template)}`);
  return e.data as EmailData<T>;
}

/** The links sendEmail would add for this template's class. */
export function sampleLinks(template: EmailTemplate): EmailLinks {
  const { appUrl, preferencesUrl, unsubscribeUrl, pauseUrl } = emailLinksExample;
  const kind = EMAIL_CLASS[template];
  if (kind === 'transactional') return { appUrl };
  return kind === 'reminder' ? { appUrl, preferencesUrl, unsubscribeUrl, pauseUrl } : { appUrl, preferencesUrl, unsubscribeUrl };
}
