import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { StaticHostingBucket } from '../constructs/static-hosting-bucket';
import { SubdomainRoutingDistribution } from '../constructs/subdomain-routing-distribution';
import { SubdomainRoutingFunction } from '../constructs/subdomain-routing-function';

export interface HostingStackProps extends cdk.StackProps {
  domainName: string;
  mainBranchName?: string;
  hostedZoneId?: string;
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

    const distribution = new SubdomainRoutingDistribution(this, 'SubdomainRoutingDistribution', {
      bucket: hostingBucket.bucket,
      domainName: props.domainName,
      certificateArn: props.certificateArn,
      routingFunction: routingFunction.function,
    });

    if (props.hostedZoneId) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName,
      });

      new route53.ARecord(this, 'ProdWildcardRecord', {
        zone: hostedZone,
        recordName: '*',
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution.distribution),
        ),
      });

      new route53.ARecord(this, 'DevWildcardRecord', {
        zone: hostedZone,
        recordName: '*.dev',
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
  }
}
