import type { RepositoryInsights } from '../../core/interfaces/repository-insights.js';
import type { UnreleasedWork } from '../../core/models/digest.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const ERROR_DETAIL_LIMIT = 300;

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

function splitFullName(fullName: string): [string, string] {
  const [owner = '', name = ''] = fullName.split('/');
  return [owner, name];
}

/**
 * Asks GitHub's GraphQL API for each repository in one request, using an alias per
 * repository and variables for every name, so names never need escaping.
 */
export class GitHubInsights implements RepositoryInsights {
  constructor(private readonly token: string) {}

  async listUnreleasedWork(repositories: readonly string[]): Promise<UnreleasedWork[]> {
    if (repositories.length === 0) {
      return [];
    }

    const latest = await this.queryEach<LatestRelease>(
      repositories.map((repository) => ({
        repository,
        variables: {},
        fields: (): string => 'url defaultBranchRef { name } latestRelease { tagName publishedAt }',
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
        repository: release.repository,
        variables: { tag: `refs/tags/${release.tagName}`, branch: release.branch },
        fields: (variable): string =>
          `ref(qualifiedName: ${variable('tag')}) { compare(headRef: ${variable('branch')}) { aheadBy } }`,
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

  /**
   * Run one query with a `repository` field per item, aliased `r0`, `r1`, and so on.
   * Each item's variables are suffixed with its index; `fields` gets their names from
   * `variable`. A repository GitHub cannot see comes back as null.
   */
  private async queryEach<T>(
    items: readonly {
      repository: string;
      variables: Record<string, string>;
      fields: (variable: (key: string) => string) => string;
    }[]
  ): Promise<(T | null)[]> {
    const declarations: string[] = [];
    const selections: string[] = [];
    const variables: Record<string, string> = {};
    for (const [index, item] of items.entries()) {
      const variable = (key: string): string => `$${key}${String(index)}`;
      const [owner, name] = splitFullName(item.repository);
      for (const [key, value] of Object.entries({ owner, name, ...item.variables })) {
        declarations.push(`${variable(key)}: String!`);
        variables[`${key}${String(index)}`] = value;
      }
      selections.push(
        `r${String(index)}: repository(owner: ${variable('owner')}, name: ${variable('name')}) { ${item.fields(variable)} }`
      );
    }

    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'repo-pulse',
      },
      body: JSON.stringify({
        query: `query(${declarations.join(', ')}) { ${selections.join(' ')} }`,
        variables,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, ERROR_DETAIL_LIMIT);
      throw new Error(`GitHub GraphQL request failed with ${String(response.status)}: ${detail}`);
    }

    const body: { data?: Record<string, T | null> | null; errors?: { message: string }[] } =
      await response.json();
    if (!body.data) {
      const messages = body.errors?.map((error) => error.message).join('; ') ?? 'no data';
      throw new Error(`GitHub GraphQL query failed: ${messages}`);
    }
    const data = body.data;
    return items.map((_, index) => data[`r${String(index)}`] ?? null);
  }
}
