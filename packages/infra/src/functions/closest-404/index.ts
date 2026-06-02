import {
  HeadObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  CloudFrontResponseEvent,
  CloudFrontResponseResult,
} from 'aws-lambda';

const s3 = new S3Client({});
const FILE_REGEX = /\.(html?|css|js|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)(\?.*)?$/i;

function isHtmlNavigation(uri: string, acceptHeader?: string): boolean {
  if (acceptHeader && acceptHeader.includes('text/html')) {
    return true;
  }
  if (uri.endsWith('.html')) {
    return true;
  }
  return !FILE_REGEX.test(uri);
}

function parseAppBranch(uri: string): { app: string; branch: string } | null {
  const segments = uri.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  return { app: segments[0], branch: segments[1] };
}

function getBucketName(
  request: CloudFrontResponseEvent['Records'][0]['cf']['request'],
): string | undefined {
  const domainName = request.origin?.s3?.domainName;
  if (!domainName) {
    return undefined;
  }
  return domainName.split('.')[0];
}

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function getObjectBody(bucket: string, key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString('utf-8');
  if (!body) {
    throw new Error(`Empty body for s3://${bucket}/${key}`);
  }
  return body;
}

export const handler = async (
  event: CloudFrontResponseEvent,
): Promise<CloudFrontResponseResult> => {
  const record = event.Records[0];
  const response = record.cf.response;
  const request = record.cf.request;
  const status = response.status;

  if (status !== '404' && status !== '403') {
    return response;
  }

  const uri = request.uri;
  const acceptHeader = request.headers.accept?.[0]?.value;
  if (!isHtmlNavigation(uri, acceptHeader)) {
    return response;
  }

  const bucket = getBucketName(request);
  if (!bucket) {
    return response;
  }

  const parsed = parseAppBranch(uri);
  if (!parsed) {
    return response;
  }

  const candidates = [
    `/${parsed.app}/${parsed.branch}/404.html`,
    `/${parsed.app}/404.html`,
    '/404.html',
  ];

  for (const candidate of candidates) {
    const key = candidate.startsWith('/') ? candidate.slice(1) : candidate;
    if (!(await objectExists(bucket, key))) {
      continue;
    }

    const body = await getObjectBody(bucket, key);
    return {
      status: '404',
      statusDescription: 'Not Found',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
        'cache-control': [{ key: 'Cache-Control', value: 'max-age=0, s-maxage=10' }],
      },
      body,
    };
  }

  return response;
};
