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
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  body: string | null;
  labels: Array<{ name: string }>;
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
}

export interface GitHubFork {
  full_name: string;
  html_url: string;
  default_branch: string;
}

export interface GitHubWebhookPayload {
  action?: string;
  repository: GitHubRepository;
  sender: GitHubUser;

  // Event-specific fields
  star?: {
    starred_at: string | null;
  };
  issue?: GitHubIssue;
  pull_request?: GitHubPullRequest;
  forkee?: GitHubFork;
}
