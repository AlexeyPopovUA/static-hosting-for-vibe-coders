export const SAFE_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function isValidLabel(name: string): boolean {
  return SAFE_LABEL_REGEX.test(name) && !name.includes('--');
}

export function isValidBranchName(name: string): boolean {
  return isValidLabel(name);
}

export function validateBranchName(name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: "${name}"`);
  }
}

export function validateAppSlug(slug: string): void {
  if (!isValidLabel(slug)) {
    throw new Error(`Invalid app slug: "${slug}"`);
  }
}
