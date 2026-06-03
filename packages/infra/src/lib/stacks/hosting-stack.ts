import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { dnsPrefix, wildcardRecordName } from '../dns';
import { DemoAppsDeployment } from '../constructs/demo-apps-deployment';
import { StaticHostingBucket } from '../constructs/static-hosting-bucket';
import { SubdomainRoutingDistribution } from '../constructs/subdomain-routing-distribution';
import { SubdomainRoutingFunction } from '../constructs/subdomain-routing-function';

export interface HostingStackProps extends cdk.StackProps {
  domainName: string;
  mainBranchName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificateArn?: string;
  environment?: string;
}

export class HostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    const mainBranchName = props.mainBranchName ?? 'main';
    const environment = props.environment ?? 'production';

    cdk.Tags.of(this).add('Project', 'static-hosting');
    cdk.Tags.of(this).add('Environment', environment);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    const hostingBucket = new StaticHostingBucket(this, 'StaticHostingBucket', {
      environment,
    });

    const routingFunction = new SubdomainRoutingFunction(this, 'SubdomainRoutingFunction', {
      mainBranchName,
    });

    const hostedZoneName = props.hostedZoneName ?? props.domainName;
    const hostedZone = props.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: props.hostedZoneId,
          zoneName: hostedZoneName,
        })
      : undefined;

    if (!props.certificateArn && !hostedZone) {
      throw new Error(
        'Either certificateArn or hostedZoneId must be provided so ACM DNS validation can be managed by CDK',
      );
    }

    const distribution = new SubdomainRoutingDistribution(this, 'SubdomainRoutingDistribution', {
      bucket: hostingBucket.bucket,
      domainName: props.domainName,
      certificateArn: props.certificateArn,
      hostedZone,
      routingFunction: routingFunction.function,
    });

    const demoApps = new DemoAppsDeployment(this, 'DemoAppsDeployment', {
      bucket: hostingBucket.bucket,
      mainBranchName,
      distribution: distribution.distribution,
      domainName: props.domainName,
    });

    if (hostedZone) {
      const prefix = dnsPrefix(props.domainName, hostedZoneName);

      new route53.ARecord(this, 'ProdWildcardRecord', {
        zone: hostedZone,
        recordName: wildcardRecordName(prefix),
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution.distribution),
        ),
      });

      new route53.ARecord(this, 'DevWildcardRecord', {
        zone: hostedZone,
        recordName: wildcardRecordName(prefix, true),
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution.distribution),
        ),
      });
    }

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://*.${props.domainName}`,
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: hostingBucket.bucket.bucketName,
    });

    new cdk.CfnOutput(this, 'DemoAppHelloUrl', {
      value: demoApps.demoUrls.hello,
      description: 'Hello demo app (static HTML + CSS)',
    });

    new cdk.CfnOutput(this, 'DemoAppPaletteUrl', {
      value: demoApps.demoUrls.palette,
      description: 'Palette demo app (HTML + CSS + JS)',
    });
  }
}
