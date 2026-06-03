export function dnsPrefix(domainName: string, hostedZoneName: string): string {
  const zone = hostedZoneName.replace(/\.$/, '');
  const domain = domainName.replace(/\.$/, '');

  if (domain === zone) {
    return '';
  }

  if (domain.endsWith(`.${zone}`)) {
    return domain.slice(0, -(zone.length + 1));
  }

  throw new Error(
    `Domain "${domainName}" is not contained in hosted zone "${hostedZoneName}"`,
  );
}

export function wildcardRecordName(prefix: string, dev = false): string {
  if (dev) {
    return prefix ? `*.dev.${prefix}` : '*.dev';
  }

  return prefix ? `*.${prefix}` : '*';
}
