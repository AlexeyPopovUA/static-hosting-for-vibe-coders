#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { hostingConfig } from '../config';
import { HostingStack } from '../lib/stacks/hosting-stack';

const app = new cdk.App();

new HostingStack(app, 'StaticHostingStack', {
  domainName: hostingConfig.domainName,
  mainBranchName: hostingConfig.mainBranchName,
  hostedZoneId: hostingConfig.hostedZoneId,
  hostedZoneName: hostingConfig.hostedZoneName,
  certificateArn: hostingConfig.certificateArn,
  environment: hostingConfig.environment,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
