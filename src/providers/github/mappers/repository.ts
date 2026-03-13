import type { Repository, User } from '../../../core/models/repo-event.js';
import { normalizeRepoFullName } from '../../../core/repository-identity.js';
import type { GitHubRepository, GitHubUser } from '../types.js';
import {
  requireNullableString,
  requireNumber,
  requireObject,
  requireString,
} from './validation.js';

export function mapRepository(repo: GitHubRepository): Repository {
  const repoData = requireObject(repo, 'repository');
  const fullName = normalizeRepoFullName(requireString(repoData.full_name, 'repository.full_name'));
  const [owner, name] = fullName.split('/') as [string, string];

  return {
    id: requireNumber(repoData.id, 'repository.id'),
    name,
    fullName,
    owner,
    url: requireString(repoData.html_url, 'repository.html_url'),
    description: requireNullableString(repoData.description, 'repository.description'),
    stars: requireNumber(repoData.stargazers_count, 'repository.stargazers_count'),
    forks: requireNumber(repoData.forks_count, 'repository.forks_count'),
    language: requireNullableString(repoData.language, 'repository.language'),
  };
}

export function mapUser(user: GitHubUser): User {
  const userData = requireObject(user, 'sender');

  return {
    id: requireNumber(userData.id, 'sender.id'),
    login: requireString(userData.login, 'sender.login'),
    avatarUrl: requireString(userData.avatar_url, 'sender.avatar_url'),
    url: requireString(userData.html_url, 'sender.html_url'),
  };
}
