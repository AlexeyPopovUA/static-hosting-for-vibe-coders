import { describe, expect, it } from 'vitest';
import {
  isValidBranchName,
  sanitizeBranchName,
  validateAppSlug,
  validateBranchName,
} from '../lib/validation';

describe('sanitizeBranchName', () => {
  it('lowercases and replaces unsupported characters', () => {
    expect(sanitizeBranchName('feature/login')).toBe('feature-login');
    expect(sanitizeBranchName('Feature/New__UI')).toBe('feature-new-ui');
    expect(sanitizeBranchName('fix/bug...#123')).toBe('fix-bug-123');
    expect(sanitizeBranchName('refs/heads/feature/login')).toBe('feature-login');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeBranchName('--main--')).toBe('main');
  });

  it('truncates to 63 characters', () => {
    const longName = 'a'.repeat(80);
    expect(sanitizeBranchName(longName)).toHaveLength(63);
  });
});

describe('validateBranchName', () => {
  it('accepts valid branch names', () => {
    expect(() => validateBranchName('feat-new-ui')).not.toThrow();
    expect(() => validateBranchName('main')).not.toThrow();
  });

  it('rejects invalid branch names', () => {
    expect(() => validateBranchName('')).toThrow();
    expect(() => validateBranchName('-bad')).toThrow();
    expect(() => validateBranchName('bad-')).toThrow();
    expect(() => validateBranchName('feat--ui')).toThrow();
    expect(() => validateBranchName('UPPER')).toThrow();
  });
});

describe('validateAppSlug', () => {
  it('accepts valid app slugs', () => {
    expect(() => validateAppSlug('my-app')).not.toThrow();
    expect(() => validateAppSlug('example1')).not.toThrow();
  });

  it('rejects invalid app slugs', () => {
    expect(() => validateAppSlug('my--app')).toThrow();
    expect(() => validateAppSlug('My-App')).toThrow();
  });
});

describe('isValidBranchName', () => {
  it('matches validateBranchName behavior', () => {
    expect(isValidBranchName('feat-new-ui')).toBe(true);
    expect(isValidBranchName('feat--ui')).toBe(false);
  });
});
