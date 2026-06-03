import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'node:path';

const DEMO_APPS = ['hello', 'palette'] as const;

export interface DemoAppsDeploymentProps {
  bucket: s3.IBucket;
  mainBranchName: string;
  distribution: cloudfront.IDistribution;
  domainName: string;
}

export class DemoAppsDeployment extends Construct {
  readonly demoUrls: Record<(typeof DEMO_APPS)[number], string>;

  constructor(scope: Construct, id: string, props: DemoAppsDeploymentProps) {
    super(scope, id);

    const assetsRoot = path.join(__dirname, '../../../assets/demo-apps');
    this.demoUrls = {} as Record<(typeof DEMO_APPS)[number], string>;

    for (const app of DEMO_APPS) {
      const prefix = `${app}/${props.mainBranchName}`;

      new s3deploy.BucketDeployment(this, `${app}Deployment`, {
        sources: [s3deploy.Source.asset(path.join(assetsRoot, app))],
        destinationBucket: props.bucket,
        destinationKeyPrefix: prefix,
        distribution: props.distribution,
        distributionPaths: [`/${prefix}/*`],
        cacheControl: [s3deploy.CacheControl.fromString('max-age=0, s-maxage=300')],
        prune: false,
      });

      this.demoUrls[app] = `https://${app}.${props.domainName}`;
    }
  }
}
