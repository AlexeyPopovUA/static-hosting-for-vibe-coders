import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { experimental } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Duration, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface SubdomainRoutingDistributionProps {
  bucket: s3.IBucket;
  domainName: string;
  certificateArn?: string;
  hostedZone?: route53.IHostedZone;
  routingFunction: cloudfront.IFunction;
}

export class SubdomainRoutingDistribution extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SubdomainRoutingDistributionProps) {
    super(scope, id);

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)
      : (() => {
          if (!props.hostedZone) {
            throw new Error('hostedZone is required when creating a new ACM certificate');
          }

          return new acm.Certificate(this, 'Certificate', {
            domainName: props.domainName,
            subjectAlternativeNames: [
              `*.${props.domainName}`,
              `*.dev.${props.domainName}`,
            ],
            validation: acm.CertificateValidation.fromDns(props.hostedZone),
          });
        })();

    const closest404Path = path.join(__dirname, '../../functions/closest-404');

    const closest404Function = new experimental.EdgeFunction(this, 'Closest404Resolver', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(closest404Path, {
        bundling: {
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(
                  `npx esbuild ${path.join(closest404Path, 'index.ts')} --bundle --platform=node --target=node20 --outfile=${path.join(outputDir, 'index.js')}`,
                  { stdio: 'inherit' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'cp -r /asset-input/* /asset-output/',
              'cd /asset-output',
              'npm init -y >/dev/null 2>&1',
              'npm install @aws-sdk/client-s3 esbuild typescript @types/aws-lambda @types/node >/dev/null 2>&1',
              'npx esbuild index.ts --bundle --platform=node --target=node20 --outfile=index.js',
              'rm -f index.ts package.json package-lock.json',
            ].join(' && '),
          ],
        },
      }),
      description: 'Serve closest 404.html for HTML navigation misses',
    });

    props.bucket.grantRead(closest404Function);
    closest404Function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:HeadObject'],
        resources: [props.bucket.arnForObjects('*')],
      }),
    );

    const closest404Role = closest404Function.lambda.role;
    if (!closest404Role) {
      throw new Error('Closest404Resolver execution role is required');
    }

    props.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowClosest404LambdaEdgeRead',
        actions: ['s3:GetObject'],
        resources: [props.bucket.arnForObjects('*')],
        principals: [closest404Role],
      }),
    );

    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: `${Stack.of(this).stackName}-html-cache`,
      defaultTtl: Duration.seconds(300),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(300),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const staticCachePolicy = cloudfront.CachePolicy.CACHING_OPTIMIZED;

    const origin = S3BucketOrigin.withOriginAccessControl(props.bucket);

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: htmlCachePolicy,
        functionAssociations: [
          {
            function: props.routingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
        edgeLambdas: [
          {
            functionVersion: closest404Function.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
          },
        ],
      },
      additionalBehaviors: {
        '*.js': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: staticCachePolicy,
          functionAssociations: [
            {
              function: props.routingFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '*.css': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: staticCachePolicy,
          functionAssociations: [
            {
              function: props.routingFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '*.png': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: staticCachePolicy,
          functionAssociations: [
            {
              function: props.routingFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '*.jpg': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: staticCachePolicy,
          functionAssociations: [
            {
              function: props.routingFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '*.svg': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: staticCachePolicy,
          functionAssociations: [
            {
              function: props.routingFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '*.woff2': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: staticCachePolicy,
          functionAssociations: [
            {
              function: props.routingFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      domainNames: [`*.${props.domainName}`, `*.dev.${props.domainName}`],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    new ssm.StringParameter(this, 'DistributionIdParameter', {
      parameterName: '/static-hosting/distribution-id',
      stringValue: this.distribution.distributionId,
      description: 'Static hosting CloudFront distribution ID',
    });
  }
}
