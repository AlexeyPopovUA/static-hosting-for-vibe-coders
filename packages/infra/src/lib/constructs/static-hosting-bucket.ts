import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface StaticHostingBucketProps {
  environment?: string;
}

export class StaticHostingBucket extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StaticHostingBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    cdk.Tags.of(this.bucket).add('Project', 'static-hosting');
    cdk.Tags.of(this.bucket).add('ManagedBy', 'CDK');
    if (props?.environment) {
      cdk.Tags.of(this.bucket).add('Environment', props.environment);
    }

    new ssm.StringParameter(this, 'BucketNameParameter', {
      parameterName: '/static-hosting/bucket-name',
      stringValue: this.bucket.bucketName,
      description: 'Static hosting S3 bucket name',
    });

    new s3deploy.BucketDeployment(this, 'Global404Deployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../assets/global-404'))],
      destinationBucket: this.bucket,
      cacheControl: [s3deploy.CacheControl.fromString('max-age=0, s-maxage=10')],
      contentType: 'text/html; charset=utf-8',
      prune: false,
    });
  }
}
