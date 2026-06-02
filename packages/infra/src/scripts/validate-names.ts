import {
  sanitizeBranchName,
  validateAppSlug,
  validateBranchName,
} from '../lib/validation';

function parseArgs(argv: string[]): {
  app?: string;
  branch?: string;
  printSanitizedBranch: boolean;
} {
  const result: {
    app?: string;
    branch?: string;
    printSanitizedBranch: boolean;
  } = { printSanitizedBranch: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app' && argv[i + 1]) {
      result.app = argv[++i];
    } else if (arg === '--branch' && argv[i + 1]) {
      result.branch = argv[++i];
    } else if (arg === '--print-sanitized-branch') {
      result.printSanitizedBranch = true;
    }
  }

  return result;
}

function main(): void {
  const { app, branch, printSanitizedBranch } = parseArgs(process.argv.slice(2));

  if (!app) {
    console.error(
      'Usage: validate-names --app <slug> [--branch <name>] [--print-sanitized-branch]',
    );
    process.exit(1);
  }

  try {
    validateAppSlug(app);

    if (branch !== undefined) {
      const sanitized = sanitizeBranchName(branch);
      validateBranchName(sanitized);

      if (printSanitizedBranch) {
        console.log(sanitized);
        return;
      }

      console.log(`Validated app="${app}" branch="${sanitized}"`);
    } else {
      if (printSanitizedBranch) {
        console.error('--print-sanitized-branch requires --branch');
        process.exit(1);
      }
      console.log(`Validated app="${app}"`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
