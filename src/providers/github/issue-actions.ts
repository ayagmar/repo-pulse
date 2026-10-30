import type { Repository } from '../../core/models/repo-event.js';
import {
  boundedMessage,
  type Redactor,
  transportFailure,
  upstreamFailure,
} from '../../core/security/redact.js';
import type { InstallationTokenRequest } from './app-auth.js';

const API_URL = 'https://api.github.com';
/** Each request, body included, gets this long; the receipt has to go out after it. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Issue writes only, and only on the repository acted on. */
function issuesWriteToken(repository: Pick<Repository, 'name'>): InstallationTokenRequest {
  return { permissions: { issues: 'write' }, repositories: [repository.name] };
}

export type IssueWriteResult = { ok: true } | { ok: false; error: string };

/**
 * The two issue writes Discord alerts offer. Both are idempotent on GitHub: closing a
 * closed issue and adding a label it has change nothing. Failures, the token's
 * included, come back as GitHub's status and message, redacted; they never throw.
 */
export class GitHubIssueActions {
  constructor(
    private readonly token: (request: InstallationTokenRequest) => Promise<string>,
    private readonly redactor: Redactor
  ) {}

  close(repository: Repository, issueNumber: number): Promise<IssueWriteResult> {
    return this.write(repository, 'PATCH', `/issues/${String(issueNumber)}`, {
      state: 'closed',
    });
  }

  /** Adds to the issue's labels; GitHub creates a label that does not exist yet. */
  addLabels(
    repository: Repository,
    issueNumber: number,
    labels: readonly string[]
  ): Promise<IssueWriteResult> {
    return this.write(repository, 'POST', `/issues/${String(issueNumber)}/labels`, {
      labels: [...labels],
    });
  }

  private async write(
    repository: Repository,
    method: 'PATCH' | 'POST',
    path: string,
    body: unknown
  ): Promise<IssueWriteResult> {
    let token: string;
    try {
      token = await this.token(issuesWriteToken(repository));
    } catch (error) {
      // The token provider's errors are already fixed or redacted messages.
      return {
        ok: false,
        error: boundedMessage(
          error instanceof Error ? error.message : String(error),
          this.redactor
        ),
      };
    }

    const label = 'GitHub request';
    let response: Response;
    let text: string;
    try {
      response = await fetch(
        `${API_URL}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${path}`,
        {
          method,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'repo-pulse',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify(body),
        }
      );
      text = await response.text();
    } catch (error) {
      return { ok: false, error: transportFailure(label, error) };
    }
    return response.ok
      ? { ok: true }
      : { ok: false, error: upstreamFailure(label, response.status, text, this.redactor) };
  }
}
