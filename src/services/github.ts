import { BRANDING_EMAIL } from '@lobechat/business-const';
import qs from 'query-string';
import urlJoin from 'url-join';

import { GITHUB } from '@/const/url';

// Keep error drafts local until the user sends the email or submits the issue.
const openIssue = (query: { body: string; labels: string; title: string }) => {
  if (BRANDING_EMAIL.support) {
    window.location.href = `mailto:${BRANDING_EMAIL.support}?subject=${encodeURIComponent(query.title)}&body=${encodeURIComponent(query.body)}`;
    return;
  }

  window.open(qs.stringifyUrl({ query, url: urlJoin(GITHUB, '/issues/new') }), '_blank');
};

class GitHubService {
  submitDBV1UpgradeError = (version: number, error?: { message: string }) => {
    const body = ['```json', JSON.stringify(error, null, 2), '```'].join('\n');

    const message = error?.message || '';

    openIssue({
      body,
      labels: '❌ Database Migration Error',
      title: `[Migration Error V${version}] ${message}`,
    });
  };

  submitImportError = (error?: { message: string }) => {
    const body = ['```json', JSON.stringify(error, null, 2), '```'].join('\n');

    const message = error?.message || '';

    openIssue({
      body,
      labels: '❌ Import Config Error',
      title: `[Config Import Error] ${message}`,
    });
  };

  submitPgliteInitError = (error?: { message: string }) => {
    const body = ['```json', JSON.stringify(error, null, 2), '```'].join('\n');

    const message = error?.message || '';

    openIssue({
      body,
      labels: '❌ Database Init Error',
      title: `[Database Init Error] ${message}`,
    });
  };
}

export const githubService = new GitHubService();
