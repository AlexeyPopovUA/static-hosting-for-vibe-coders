export interface HostingConfig {
  domainName: string;
  mainBranchName: string;
  hostedZoneId?: string;
  certificateArn?: string;
  environment: string;
}

export const hostingConfig: HostingConfig = {
  domainName: process.env.HOSTING_DOMAIN_NAME ?? 'demo.oleksiipopov.com',
  mainBranchName: process.env.HOSTING_MAIN_BRANCH ?? 'main',
  hostedZoneId: process.env.HOSTING_HOSTED_ZONE_ID,
  certificateArn: process.env.HOSTING_CERTIFICATE_ARN,
  environment: process.env.HOSTING_ENVIRONMENT ?? 'production',
};
