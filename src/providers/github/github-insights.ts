import type { RepositoryInsights, UserProfile } from '../../core/interfaces/repository-insights.js';
import type { UnreleasedWork } from '../../core/models/digest.js';
import type { Referrer } from '../../core/models/momentum-alert.js';
import {
  boundedMessage,
  type Redactor,
  transportFailure,
  upstreamFailure,
} from '../../core/security/redact.js';
import { logger } from '../../core/services/logger.js';

const API_URL = 'https://api.github.com';
/** A digest or alert waits this long for GitHub, then goes out without its details. */
const REQUEST_TIMEOUT_MS = 5_000;

interface LatestRelease {
  url: string;
  defaultBranchRef: { name: string } | null;
  latestRelease: { tagName: string; publishedAt: string } | null;
}

interface ReleaseComparison {
  ref: { compare: { aheadBy: number } | null } | null;
}

interface Released {
  repository: string;
  url: string;
  branch: string;
  tagName: string;
  publishedAt: string;
}

interface AliasedField {
  variables: Record<string, string>;
  /** The field to select, given the query-wide name of each of its variables. */
  field: (variable: (key: string) => string) => string;
}

function splitFullName(fullName: string): { owner: string; name: string } {
  const [owner = '', name = ''] = fullName.split('/');
  return { owner, name };
}

/** A `repository` field for the `owner` and `name` variables, selecting `fields`. */
function repositoryField(fields: AliasedField['field']): AliasedField['field'] {
  return (variable) =>
    `repository(owner: ${variable('owner')}, name: ${variable('name')}) { ${fields(variable)} }`;
}

/**
 * Reads GitHub's API with a read-only token. GraphQL questions about several
 * repositories or users are asked in one request, with an alias per item and
 * variables for every name, so names never need escaping. Errors keep GitHub's
 * status and message, with credentials redacted.
 */
export class GitHubInsights implements RepositoryInsights {
  constructor(
    /** The token for each request: a fixed one, or the App's installation token. */
    private readonly token: () => Promise<string>,
    private readonly redactor: Redactor
  ) {}

  async listUnreleasedWork(repositories: readonly string[]): Promise<UnreleasedWork[]> {
    if (repositories.length === 0) {
      return [];
    }

    const latest = await this.queryEach<LatestRelease>(
      repositories.map((repository) => ({
        variables: splitFullName(repository),
        field: repositoryField(
          () => 'url defaultBranchRef { name } latestRelease { tagName publishedAt }'
        ),
      }))
    );
    const released: Released[] = [];
    for (const [index, repository] of repositories.entries()) {
      const node = latest[index];
      if (node?.defaultBranchRef && node.latestRelease) {
        released.push({
          repository,
          url: node.url,
          branch: node.defaultBranchRef.name,
          tagName: node.latestRelease.tagName,
          publishedAt: node.latestRelease.publishedAt,
        });
      }
    }
    if (released.length === 0) {
      return [];
    }

    const comparisons = await this.queryEach<ReleaseComparison>(
      released.map((release) => ({
        variables: {
          ...splitFullName(release.repository),
          tag: `refs/tags/${release.tagName}`,
          branch: release.branch,
        },
        field: repositoryField(
          (variable) =>
            `ref(qualifiedName: ${variable('tag')}) { compare(headRef: ${variable('branch')}) { aheadBy } }`
        ),
      }))
    );
    return released.flatMap((release, index) => {
      const aheadBy = comparisons[index]?.ref?.compare?.aheadBy ?? 0;
      if (aheadBy === 0) {
        return [];
      }
      return [
        {
          repository: release.repository,
          compareUrl: `${release.url}/compare/${encodeURIComponent(release.tagName)}...${encodeURIComponent(release.branch)}`,
          tagName: release.tagName,
          releasedAt: new Date(release.publishedAt),
          commitsSinceRelease: aheadBy,
        },
      ];
    });
  }

  async getUserProfiles(logins: readonly string[]): Promise<UserProfile[]> {
    if (logins.length === 0) {
      return [];
    }

    const users = await this.queryEach<{
      login: string;
      url: string;
      followers: { totalCount: number };
    }>(
      logins.map((login) => ({
        variables: { login },
        field: (variable): string =>
          `user(login: ${variable('login')}) { login url followers { totalCount } }`,
      }))
    );
    return users.flatMap((user) =>
      user ? [{ login: user.login, url: user.url, followers: user.followers.totalCount }] : []
    );
  }

  async listTopReferrers(repository: string): Promise<Referrer[]> {
    const { owner, name } = splitFullName(repository);
    const referrers = (await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/traffic/popular/referrers`
    )) as { referrer: string; count: number; uniques: number }[];
    return referrers.map((referrer) => ({
      name: referrer.referrer,
      views: referrer.count,
      uniqueVisitors: referrer.uniques,
    }));
  }

  /**
   * Run one GraphQL query that selects each item's field under the alias `r0`, `r1`,
   * and so on. Each item's variables are suffixed with its index. An item GitHub
   * cannot see, such as a deleted repository, comes back as null.
   */
  private async queryEach<T>(items: readonly AliasedField[]): Promise<(T | null)[]> {
    const declarations: string[] = [];
    const selections: string[] = [];
    const variables: Record<string, string> = {};
    for (const [index, item] of items.entries()) {
      const suffix = String(index);
      for (const [key, value] of Object.entries(item.variables)) {
        declarations.push(`$${key}${suffix}: String!`);
        variables[`${key}${suffix}`] = value;
      }
      selections.push(`r${suffix}: ${item.field((key) => `$${key}${suffix}`)}`);
    }

    const body = (await this.request('/graphql', {
      query: `query(${declarations.join(', ')}) { ${selections.join(' ')} }`,
      variables,
    })) as { data?: Record<string, T | null> | null; errors?: { message: string }[] };
    const joined = body.errors?.map((error) => error.message).join('; ');
    const messages = joined === undefined ? undefined : boundedMessage(joined, this.redactor);
    if (!body.data) {
      throw new Error(`GitHub GraphQL query failed: ${messages ?? 'no data'}`);
    }
    if (messages !== undefined && messages !== '') {
      // Items GitHub could not answer for, such as a repository the token cannot read,
      // come back as null next to these errors.
      logger.warn('github.graphql_partial_errors', { component: 'github', errors: messages });
    }
    const data = body.data;
    return items.map((_, index) => data[`r${String(index)}`] ?? null);
  }

  /**
   * GET `path`, or POST `body` as JSON to it, and return the parsed response. Throws
   * on a non-2xx response. A failure while sending or reading, or a body that is not
   * JSON, becomes a fixed message: the exception's text can quote the request or body.
   */
  private async request(path: string, body?: unknown): Promise<unknown> {
    const token = await this.token();
    const label = `GitHub ${path}`;
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${API_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'repo-pulse',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch (error) {
      // The exception can quote the request, so it is not kept as the cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(transportFailure(label, error));
    }
    if (!response.ok) {
      throw new Error(upstreamFailure(label, response.status, text, this.redactor));
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${label} returned a body that is not JSON`);
    }
  }
}
