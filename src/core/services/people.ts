/** Whether a login is a GitHub bot account (`renovate[bot]`). */
export function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith('[bot]');
}

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
  const excluded = isBotLogin(login) || ignoredLogins.has(login) || login === owner;
  return !excluded;
}

/**
 * Which side of a conversation a sender is on. `owner` is the repository's owner or a
 * login in `PEOPLE_IGNORED_LOGINS` (collaborators, the owner's other accounts); `outside`
 * is what `isOutsidePerson` accepts. Bots, and senders without a valid id and login,
 * are neither: they never answer anyone and never make anyone wait.
 */
export function conversationSide(
  sender: { id: unknown; login: unknown },
  repositoryOwner: unknown,
  ignoredLogins: ReadonlySet<string>
): 'owner' | 'outside' | null {
  if (isOutsidePerson(sender, repositoryOwner, ignoredLogins)) {
    return 'outside';
  }
  if (typeof sender.id !== 'number' || !Number.isSafeInteger(sender.id) || sender.id <= 0) {
    return null;
  }
  if (typeof sender.login !== 'string' || sender.login === '') {
    return null;
  }
  const login = sender.login.toLowerCase();
  if (isBotLogin(login)) {
    return null;
  }
  const owner = typeof repositoryOwner === 'string' ? repositoryOwner.toLowerCase() : null;
  return ignoredLogins.has(login) || login === owner ? 'owner' : null;
}
