/**
 * Whether a sender is an outside person, whose events Repo Pulse remembers and lists:
 * identified by a GitHub user id, and not the repository's owner, a login in
 * `PEOPLE_IGNORED_LOGINS` or a bot. Logins compare case-insensitively, as GitHub's do.
 */
export function isOutsidePerson(
  sender: { id: unknown; login: unknown },
  repositoryOwner: unknown,
  ignoredLogins: ReadonlySet<string>
): boolean {
  if (typeof sender.id !== 'number' || !Number.isSafeInteger(sender.id) || sender.id <= 0) {
    return false;
  }
  if (typeof sender.login !== 'string' || sender.login === '') {
    return false;
  }

  const login = sender.login.toLowerCase();
  const owner = typeof repositoryOwner === 'string' ? repositoryOwner.toLowerCase() : null;
  const excluded = login.endsWith('[bot]') || ignoredLogins.has(login) || login === owner;
  return !excluded;
}
