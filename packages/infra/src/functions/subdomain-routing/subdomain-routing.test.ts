import { describe, expect, it } from 'vitest';
import { isValidLabel } from '../../lib/validation';

const CLOUDFRONT_SAFE_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function cloudFrontIsValidLabel(name: string): boolean {
  if (!name || name.includes('--')) {
    return false;
  }
  return CLOUDFRONT_SAFE_LABEL_REGEX.test(name);
}

const cases = [
  { name: 'my-app', valid: true },
  { name: 'example1', valid: true },
  { name: 'feat-new-ui', valid: true },
  { name: 'a', valid: true },
  { name: '', valid: false },
  { name: '-bad', valid: false },
  { name: 'bad-', valid: false },
  { name: 'feat--ui', valid: false },
  { name: 'UPPER', valid: false },
  { name: 'a'.repeat(64), valid: false },
];

describe('CloudFront function validation parity', () => {
  it.each(cases)('matches validation.ts for "$name"', ({ name, valid }) => {
    expect(isValidLabel(name)).toBe(valid);
    expect(cloudFrontIsValidLabel(name)).toBe(valid);
  });
});
