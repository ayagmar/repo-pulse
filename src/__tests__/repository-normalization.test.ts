import { describe, expect, it } from 'vitest';
import { normalizeRepoFullName } from '../core/repository-identity.js';

describe('normalizeRepoFullName', () => {
  it('returns canonical owner/repo format', () => {
    expect(normalizeRepoFullName('owner/repo')).toBe('owner/repo');
  });

  it('trims whitespace', () => {
    expect(normalizeRepoFullName('  owner/repo  ')).toBe('owner/repo');
  });

  it('extracts from full GitHub URL', () => {
    expect(normalizeRepoFullName('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('handles clone URLs with suffixes and query strings', () => {
    expect(normalizeRepoFullName('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(normalizeRepoFullName('https://github.com/owner/repo/?tab=readme')).toBe('owner/repo');
  });

  it('removes leading/trailing slashes', () => {
    expect(normalizeRepoFullName('/owner/repo/')).toBe('owner/repo');
  });

  it('throws for invalid format (no slash)', () => {
    expect(() => normalizeRepoFullName('owner')).toThrow();
  });

  it('throws for invalid format (multiple slashes)', () => {
    expect(() => normalizeRepoFullName('owner/repo/extra')).toThrow();
  });

  it('handles wildcards', () => {
    expect(normalizeRepoFullName('*/*')).toBe('*/*');
    expect(normalizeRepoFullName('myorg/*')).toBe('myorg/*');
  });
});
