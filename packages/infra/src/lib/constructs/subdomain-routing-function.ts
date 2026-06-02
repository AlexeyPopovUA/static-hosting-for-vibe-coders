import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

export interface SubdomainRoutingFunctionProps {
  mainBranchName: string;
}

export class SubdomainRoutingFunction extends Construct {
  readonly function: cloudfront.Function;

  constructor(scope: Construct, id: string, props: SubdomainRoutingFunctionProps) {
    super(scope, id);

    const sourcePath = path.join(__dirname, '../../functions/subdomain-routing/index.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const code = source.replace(
      'MAIN_BRANCH_NAME_PLACEHOLDER',
      props.mainBranchName.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    );

    this.function = new cloudfront.Function(this, 'Function', {
      code: cloudfront.FunctionCode.fromInline(code),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Rewrite subdomain host to S3 app/branch prefix',
    });
  }
}
