/**
 * Normalize a repository identifier to the canonical owner/repo shape used internally.
 */
export function normalizeRepoFullName(fullName: string): string {
  let normalized = fullName.trim();

  normalized = normalized
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '');

  normalized = normalized.split('?')[0] ?? normalized;
  normalized = normalized.split('#')[0] ?? normalized;
  normalized = normalized.replace(/\.git$/i, '');
  normalized = normalized.replace(/^\/+|\/+$/g, '');

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Invalid repository format: ${fullName}`);
  }

  const [owner, repo] = parts as [string, string];

  return `${owner}/${repo}`;
}
