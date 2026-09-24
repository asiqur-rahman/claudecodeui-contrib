import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { credentialsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import type { WorkspacePathValidationResult } from '@/shared/types.js';
import {
  AppError,
  CREDENTIAL_TYPE_BY_PROVIDER,
  getNonGithubBasicAuthCredentials,
  validateUrlMatchesProvider,
  validateWorkspacePath,
  type GitProvider,
} from '@/shared/utils.js';

const SCP_LIKE_SSH_PATTERN = /^(?:ssh:\/\/)?git@([^:/]+)[:/]/;

/** Extracts the host from an SCP-style SSH URL (`git@host:owner/repo.git`), which `new URL()` rejects outright. */
function extractScpLikeSshHost(url: string): string | null {
  const match = SCP_LIKE_SSH_PATTERN.exec(url.trim());
  return match ? match[1] : null;
}

type CloneProjectInput = {
  workspacePath: string;
  githubUrl: string;
  gitProvider?: GitProvider;
  githubTokenId?: number | null;
  newGithubToken?: string | null;
  userId: number | string;
};

type CloneCompletePayload = {
  project: Record<string, unknown>;
  message: string;
};

type CloneProjectEventHandlers = {
  onProgress: (message: string) => void;
  onComplete: (payload: CloneCompletePayload) => void;
};

type GitCloneProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  kill(): void;
};

type CloneProjectDependencies = {
  validatePath: (requestedPath: string) => Promise<WorkspacePathValidationResult>;
  ensureDirectory: (directoryPath: string) => Promise<void>;
  pathExists: (targetPath: string) => Promise<boolean>;
  removePath: (targetPath: string) => Promise<void>;
  getCredentialById: (
    credentialId: number,
    userId: number,
    credentialType: string,
  ) => Promise<{ credential_value: string } | null>;
  spawnGitClone: (
    cloneUrl: string,
    clonePath: string,
    environment: NodeJS.ProcessEnv,
  ) => GitCloneProcess;
  registerProject: (projectPath: string, customName: string) => Promise<{ project: Record<string, unknown> }>;
  logError: (message: string, error: unknown) => void;
};

export type CloneProjectOperation = {
  waitForCompletion: Promise<void>;
  cancel: () => void;
};

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/**
 * Builds the credential-helper key for one origin. The helper answers a
 * challenge from that host over https only; a helper that answered every
 * challenge would hand the token to whatever host the clone URL names — and
 * over plain http, in the clear.
 */
function buildCredentialHelperScope(host: string): string {
  return `credential.https://${host}.helper`;
}

/**
 * Builds the environment the clone runs in. The token never goes into the
 * clone URL: git echoes that URL on stderr (which is the SSE progress stream),
 * it sits in the process argv (readable through /proc) and it is written to the
 * cloned repo's `.git/config` as the remote. Instead env-only config points git
 * at a credential helper that reads the token from its own environment, so no
 * channel git exposes carries it. The empty first helper entry clears any
 * helper configured on the machine so a credential stored there cannot shadow
 * the one the user selected.
 *
 * `host` is the host the clone URL named and the provider check accepted, so
 * the helper is scoped to that one origin; `username` is the form the selected
 * provider authenticates with. Without a host there is nothing to scope the
 * helper to (an SSH clone consumes no https credential), so no helper is
 * configured at all.
 */
function buildGitCloneEnvironment(
  githubToken: string | null,
  scope: { host: string | null; username: string },
): NodeJS.ProcessEnv {
  if (!githubToken || !scope.host) {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  }

  return {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: buildCredentialHelperScope(scope.host),
    GIT_CONFIG_VALUE_1: `!f() { echo username=${scope.username}; echo "password=$CLOUDCLI_GITHUB_TOKEN"; }; f`,
    CLOUDCLI_GITHUB_TOKEN: githubToken,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function resolveCloneFailureMessage(lastError: string): string {
  if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
    return 'Authentication failed. Please check your credentials.';
  }

  if (lastError.includes('Repository not found')) {
    return 'Repository not found. Please check the URL and ensure you have access.';
  }

  if (lastError.includes('already exists')) {
    return 'Directory already exists';
  }

  return lastError || 'Git clone failed';
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unexpected error';
}

const defaultDependencies: CloneProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureDirectory: async (directoryPath: string): Promise<void> => {
    await mkdir(directoryPath, { recursive: true });
  },
  pathExists: defaultPathExists,
  removePath: async (targetPath: string): Promise<void> => {
    await rm(targetPath, { recursive: true, force: true });
  },
  getCredentialById: async (
    credentialId: number,
    userId: number,
    credentialType: string,
  ): Promise<{ credential_value: string } | null> => {
    return credentialsDb.getCredentialById(userId, credentialId, credentialType);
  },
  spawnGitClone: (
    cloneUrl: string,
    clonePath: string,
    environment: NodeJS.ProcessEnv,
  ): GitCloneProcess =>
    spawn('git', ['clone', '--progress', '--', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    }) as unknown as GitCloneProcess,
  registerProject: async (
    projectPath: string,
    customName: string,
  ): Promise<{ project: Record<string, unknown> }> =>
    createProject({
      projectPath,
      customName,
    }) as Promise<{ project: Record<string, unknown> }>,
  logError: (message: string, error: unknown): void => {
    console.error(message, error);
  },
};

/**
 * Whether a clone URL embeds a credential: any password, or a username on an
 * http(s) URL. An SSH URL's `git@` is a login name, not a secret.
 */
function carriesCredentials(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // scp-like `git@github.com:org/repo.git` and bare paths are not URLs;
    // an scp-like user is an SSH login, which is not a credential.
    return false;
  }
  if (parsed.password) {
    return true;
  }
  return Boolean(parsed.username) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

function isParsableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export async function startCloneProject(
  input: CloneProjectInput,
  handlers: CloneProjectEventHandlers,
  dependencyOverrides: Partial<CloneProjectDependencies> = {},
): Promise<CloneProjectOperation> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const normalizedWorkspacePath = input.workspacePath.trim();
  const normalizedGithubUrl = input.githubUrl.trim();

  if (!normalizedWorkspacePath) {
    throw new AppError('workspacePath and githubUrl are required', {
      code: 'WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  if (!normalizedGithubUrl) {
    throw new AppError('workspacePath and githubUrl are required', {
      code: 'GITHUB_URL_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalizedGithubUrl.startsWith('-')) {
    throw new AppError('Invalid githubUrl', {
      code: 'INVALID_GITHUB_URL',
      statusCode: 400,
    });
  }

  // An http(s) string the URL parser rejects (a bad port, a space in the
  // host) is one curl rejects too — but only after git has carried it, and
  // any credential in it, on its command line.
  if (/^https?:/i.test(normalizedGithubUrl) && !isParsableUrl(normalizedGithubUrl)) {
    throw new AppError('Invalid githubUrl', {
      code: 'INVALID_GITHUB_URL',
      statusCode: 400,
    });
  }

  if (carriesCredentials(normalizedGithubUrl)) {
    // The token field is the only way in: a credential in the URL would ride
    // git's argv, its stderr and the clone's `.git/config`.
    throw new AppError('Put the token in the token field, not in the URL', {
      code: 'GITHUB_URL_CARRIES_CREDENTIALS',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedWorkspacePath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError(pathValidation.error || 'Invalid workspace path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
    });
  }

  const absolutePath = pathValidation.resolvedPath;
  await dependencies.ensureDirectory(absolutePath);

  const gitProvider: GitProvider = input.gitProvider || 'github';
  const credentialType = gitProvider === 'custom' ? null : CREDENTIAL_TYPE_BY_PROVIDER[gitProvider];

  let githubToken: string | null = null;
  if (typeof input.githubTokenId === 'number') {
    if (!credentialType) {
      throw new AppError('Stored credentials are not supported for Custom Git; paste a token for this clone instead.', {
        code: 'CUSTOM_PROVIDER_NO_STORED_CREDENTIAL',
        statusCode: 400,
      });
    }

    const numericUserId =
      typeof input.userId === 'number' ? input.userId : Number.parseInt(String(input.userId), 10);
    if (Number.isNaN(numericUserId)) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    const credential = await dependencies.getCredentialById(input.githubTokenId, numericUserId, credentialType);
    if (!credential) {
      throw new AppError('Credential not found', {
        code: 'GITHUB_TOKEN_NOT_FOUND',
        statusCode: 404,
      });
    }

    githubToken = credential.credential_value;
  } else if (input.newGithubToken && input.newGithubToken.trim().length > 0) {
    githubToken = input.newGithubToken.trim();
  }

  const sanitizedGithubUrl = normalizedGithubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const repoName = sanitizedGithubUrl.split('/').pop() || 'repository';
  const clonePath = path.join(absolutePath, repoName);

  if (await dependencies.pathExists(clonePath)) {
    throw new AppError(
      `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.`,
      {
        code: 'CLONE_TARGET_ALREADY_EXISTS',
        statusCode: 409,
      },
    );
  }

  // The host the clone will talk to, when its URL names one. A credential is
  // only ever offered to that host over https (see buildGitCloneEnvironment),
  // so the URL's own scheme is not what keeps the token safe — which is why a
  // local `file://` URL or a plain-http remote stays cloneable, anonymously.
  let cloneHost: string | null = null;
  try {
    cloneHost = new URL(normalizedGithubUrl).hostname || null;
  } catch {
    // new URL() rejects SCP-style SSH syntax (git@host:owner/repo.git) outright;
    // read the host it names directly instead of skipping validation.
    cloneHost = extractScpLikeSshHost(normalizedGithubUrl);
    if (!cloneHost) {
      throw new AppError('Invalid githubUrl', {
        code: 'INVALID_GITHUB_URL',
        statusCode: 400,
      });
    }
  }
  if (cloneHost) {
    validateUrlMatchesProvider(gitProvider, cloneHost);
  }

  const providerCredentials = githubToken
    ? getNonGithubBasicAuthCredentials(gitProvider, githubToken)
    : null;
  handlers.onProgress(`Cloning into '${repoName}'...`);
  const gitProcess = dependencies.spawnGitClone(
    normalizedGithubUrl,
    clonePath,
    buildGitCloneEnvironment(githubToken, {
      host: cloneHost,
      username: providerCredentials?.username ?? 'x-access-token',
    }),
  );
  let lastError = '';

  // `git clone --progress` writes every byte of its progress to stderr. Git
  // was handed a credential-free URL, so each chunk is forwarded as it arrives.
  gitProcess.stdout?.on('data', (data: Buffer | string) => {
    const message = data.toString().trim();
    if (message) {
      handlers.onProgress(message);
    }
  });

  gitProcess.stderr?.on('data', (data: Buffer | string) => {
    const message = data.toString().trim();
    if (message) {
      lastError = message;
      handlers.onProgress(message);
    }
  });

  const waitForCompletion = new Promise<void>((resolve, reject) => {
    gitProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const createdProject = await dependencies.registerProject(clonePath, repoName);
          handlers.onComplete({
            project: createdProject.project,
            message: 'Repository cloned successfully',
          });
          resolve();
        } catch (error) {
          reject(
            new AppError(`Clone succeeded but failed to add project: ${resolveErrorMessage(error)}`, {
              code: 'CLONE_PROJECT_REGISTRATION_FAILED',
              statusCode: 500,
            }),
          );
        }
        return;
      }

      const errorMessage = resolveCloneFailureMessage(lastError);

      try {
        await dependencies.removePath(clonePath);
      } catch (cleanupError) {
        dependencies.logError('Failed to clean up after clone failure:', cleanupError);
      }

      reject(
        new AppError(errorMessage, {
          code: 'GIT_CLONE_FAILED',
          statusCode: 500,
        }),
      );
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new AppError('Git is not installed or not in PATH', {
            code: 'GIT_NOT_FOUND',
            statusCode: 500,
          }),
        );
        return;
      }

      reject(
        new AppError(error.message, {
          code: 'GIT_EXECUTION_FAILED',
          statusCode: 500,
        }),
      );
    });
  });

  return {
    waitForCompletion,
    cancel: () => {
      gitProcess.kill();
    },
  };
}
