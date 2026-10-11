import type { Commit, PushEvent } from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubRepository, GitHubUser, GitHubWebhookPayload } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import { requireArray, requireBoolean, requireObject, requireString } from './validation.js';

// GitHub's merge-commit and squash-merge subjects. Those pushes repeat a
// "pull request merged" notification, so they are not announced again.
const PULL_REQUEST_MERGE_SUBJECT = /^Merge pull request #\d+ |\(#\d+\)$/;

function mapCommit(value: unknown, index: number): Commit & { distinct: boolean } {
  const field = `commits[${String(index)}]`;
  const commit = requireObject(value, field);
  const author = requireObject(commit.author, `${field}.author`);
  const username = author.username;

  return {
    id: requireString(commit.id, `${field}.id`),
    message: requireString(commit.message, `${field}.message`).split('\n', 1)[0] ?? '',
    url: requireString(commit.url, `${field}.url`),
    author:
      typeof username === 'string' && username !== ''
        ? username
        : requireString(author.name, `${field}.author.name`),
    distinct: requireBoolean(commit.distinct, `${field}.distinct`),
  };
}

/**
 * Map a push to the repository's default branch. Returns null for pushes that
 * would only add noise: other branches, branch deletions, bot pushes, pushes
 * without new commits, and GitHub's own pull-request merge commits.
 */
export function mapPush(
  repository: GitHubRepository,
  sender: GitHubUser,
  payload: Partial<GitHubWebhookPayload>
): PushEvent | null {
  const repositoryData = requireObject(repository, 'repository');
  const branch = requireString(repositoryData.default_branch, 'repository.default_branch');
  if (requireString(payload.ref, 'ref') !== `refs/heads/${branch}`) {
    return null;
  }

  const mappedSender = mapUser(sender);
  const isBot = sender.type === 'Bot' || mappedSender.login.endsWith('[bot]');
  if (requireBoolean(payload.deleted, 'deleted') || isBot) {
    return null;
  }

  const commits = requireArray(payload.commits, 'commits')
    .map(mapCommit)
    .filter((commit) => commit.distinct)
    .map(({ distinct: _distinct, ...commit }) => commit);
  const [onlyCommit] = commits;
  if (
    commits.length === 0 ||
    (commits.length === 1 && onlyCommit && PULL_REQUEST_MERGE_SUBJECT.test(onlyCommit.message))
  ) {
    return null;
  }

  return createRepoEvent(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH, {
    action: REPO_EVENT_ACTIONS.PUSHED,
    repository: mapRepository(repository),
    sender: mappedSender,
    push: {
      branch,
      compareUrl: requireString(payload.compare, 'compare'),
      forced: requireBoolean(payload.forced, 'forced'),
      commits,
    },
  });
}
