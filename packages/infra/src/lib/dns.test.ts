import { describe, expect, it } from 'vitest';
import { dnsPrefix, wildcardRecordName } from './dns';

describe('dnsPrefix', () => {
  it('returns empty prefix when domain equals zone apex', () => {
    expect(dnsPrefix('oleksiipopov.com', 'oleksiipopov.com')).toBe('');
  });

  it('returns subdomain prefix for nested domain', () => {
    expect(dnsPrefix('demo.oleksiipopov.com', 'oleksiipopov.com')).toBe('demo');
  });

  it('throws when domain is outside hosted zone', () => {
    expect(() => dnsPrefix('example.com', 'oleksiipopov.com')).toThrow(
      'Domain "example.com" is not contained in hosted zone "oleksiipopov.com"',
    );
  });
});

describe('wildcardRecordName', () => {
  it('builds prod and dev wildcard names for nested domains', () => {
    expect(wildcardRecordName('demo')).toBe('*.demo');
    expect(wildcardRecordName('demo', true)).toBe('*.dev.demo');
  });

  it('builds apex wildcard names', () => {
    expect(wildcardRecordName('')).toBe('*');
    expect(wildcardRecordName('', true)).toBe('*.dev');
  });
});
