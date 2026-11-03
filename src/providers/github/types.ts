/**
 * GitHub webhook payload types
 */

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  html_url: string;
  private: boolean;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  default_branch?: string;
  /** Read only for App deliveries, which are admitted only from repositories that are not forks. */
  fork?: boolean;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
  type?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  body: string | null;
  labels: { name: string }[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  /** Present when the issue is a pull request, as on comments on pull requests. */
  pull_request?: object;
  /** Sent for pull requests on some payloads; not guaranteed. */
  draft?: boolean;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  body: string | null;
  draft: boolean;
  head: {
    ref: string;
  };
  base: {
    ref: string;
  };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
}

interface GitHubComment {
  id: number;
  html_url: string;
  body: string | null;
  created_at: string;
}

interface GitHubReview {
  id: number;
  html_url: string;
  body: string | null;
  state: string;
  submitted_at: string | null;
}

export interface GitHubFork {
  full_name: string;
  html_url: string;
  default_branch: string;
}

export interface GitHubCommit {
  id: string;
  message: string;
  url: string;
  distinct: boolean;
  author: {
    name: string;
    username?: string;
  };
}

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  prerelease: boolean;
}

export interface GitHubWebhookPayload {
  action?: string;
  repository: GitHubRepository;
  sender: GitHubUser;
  /** Present on GitHub App deliveries only. */
  installation?: { id: number };

  // Event-specific fields
  star?: {
    starred_at: string | null;
  };
  issue?: GitHubIssue;
  pull_request?: GitHubPullRequest;
  comment?: GitHubComment;
  review?: GitHubReview;
  forkee?: GitHubFork;
  release?: GitHubRelease;

  // push
  ref?: string;
  deleted?: boolean;
  forced?: boolean;
  compare?: string;
  commits?: GitHubCommit[];
}
