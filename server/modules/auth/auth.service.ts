import crypto from 'node:crypto';

import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthMode = 'account' | 'shared-password' | 'none';

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    setPasswordHash(userId: number, passwordHash: string): void;
  };
  appConfig: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser, epoch?: string): string;
};

// Hidden account used for the single-shared-password ('shared-password') and
// open-access ('none') modes. Never surfaced to a client — those modes never
// send or receive a username, only a password (or nothing, for 'none').
const SHARED_ACCOUNT_USERNAME = '__app_shared_account__';

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

// Backs the hidden account's password hash while running in open ('none')
// mode - nobody ever authenticates with it, it only exists to satisfy the
// users table's schema so the hidden account has a real, stable row.
function cryptoRandomPassword(): string {
  return crypto.randomBytes(32).toString('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  const authMode = (): AuthMode => {
    const mode = dependencies.appConfig.get('auth_mode');
    return mode === 'shared-password' || mode === 'none' ? mode : 'account';
  };

  const currentEpoch = (): string => dependencies.appConfig.get('auth_security_epoch') ?? '0';

  const bumpEpoch = (): string => {
    const next = String(Number(currentEpoch()) + 1);
    dependencies.appConfig.set('auth_security_epoch', next);
    return next;
  };

  const tokenFor = (user: AuthUser, mode: AuthMode, epoch: string) =>
    dependencies.generateToken(user, mode === 'account' ? undefined : epoch);

  return {
    getStatus() {
      return {
        needsSetup: authMode() === 'account' && !dependencies.users.hasUsers(),
        isAuthenticated: false,
        authMode: authMode(),
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    // `tokenEpoch` is whatever epoch (if any) the caller's current token carried
    // - carried forward as-is, not re-derived from the current DB epoch, so a
    // refresh never resurrects a token that a mode/password change just revoked.
    refreshSession(user: unknown, tokenEpoch?: string) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser, tokenEpoch) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },

    /**
     * Silently issues a session for open ('none' mode) installs - lazily
     * provisioning the hidden account on first call. Backs `POST /session`.
     */
    async createOpenSession() {
      const mode = authMode();
      if (mode !== 'none') {
        throw new AppError('Open sessions are not available for this installation', {
          code: 'AUTH_SECURITY_NOT_OPEN',
          statusCode: 403,
        });
      }

      let user: AuthUser | undefined = dependencies.users.getUserByUsername(SHARED_ACCOUNT_USERNAME);
      if (!user) {
        const passwordHash = await dependencies.hashPassword(cryptoRandomPassword());
        user = dependencies.users.createUser(SHARED_ACCOUNT_USERNAME, passwordHash);
      }

      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: tokenFor(user, mode, currentEpoch()),
      };
    },

    /** Verifies the shared password and issues a session. Backs `POST /unlock`. */
    async unlockWithSharedPassword(passwordInput: unknown) {
      const mode = authMode();
      if (mode !== 'shared-password') {
        throw new AppError('Password protection is not enabled for this installation', {
          code: 'AUTH_SECURITY_NOT_ENABLED',
          statusCode: 403,
        });
      }

      const password = typeof passwordInput === 'string' ? passwordInput : '';
      const user = dependencies.users.getUserByUsername(SHARED_ACCOUNT_USERNAME);
      const validPassword = user && password
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: tokenFor(user, mode, currentEpoch()),
      };
    },

    /**
     * Enables shared-password mode (or rotates the password if already
     * enabled). Backs `POST /security/enable`, behind `authenticateToken`.
     */
    async enableSharedPassword(newPasswordInput: unknown, currentPasswordInput: unknown) {
      const mode = authMode();
      if (mode === 'account') {
        throw new AppError('This installation already uses account-based login', {
          code: 'AUTH_SECURITY_ACCOUNT_MODE',
          statusCode: 403,
        });
      }

      const newPassword = typeof newPasswordInput === 'string' ? newPasswordInput : '';
      if (newPassword.length < 6) {
        throw new AppError('Password must be at least 6 characters', {
          code: 'AUTH_CREDENTIALS_TOO_SHORT',
          statusCode: 400,
        });
      }

      const existingUser = dependencies.users.getUserByUsername(SHARED_ACCOUNT_USERNAME);

      if (mode === 'shared-password') {
        const currentPassword = typeof currentPasswordInput === 'string' ? currentPasswordInput : '';
        const validCurrentPassword = existingUser && currentPassword
          ? await dependencies.comparePassword(currentPassword, existingUser.password_hash)
          : false;
        if (!validCurrentPassword) {
          throw new AppError('Current password is required and must be correct', {
            code: 'AUTH_SECURITY_CURRENT_PASSWORD_INVALID',
            statusCode: 401,
          });
        }
      }

      const passwordHash = await dependencies.hashPassword(newPassword);
      let user: AuthUser;
      if (existingUser) {
        dependencies.users.setPasswordHash(numericUserId(existingUser.id), passwordHash);
        user = existingUser;
      } else {
        user = dependencies.users.createUser(SHARED_ACCOUNT_USERNAME, passwordHash);
      }

      dependencies.appConfig.set('auth_mode', 'shared-password');
      const epoch = bumpEpoch();

      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: tokenFor(user, 'shared-password', epoch),
      };
    },

    /**
     * Turns shared-password mode back off (open access). Backs
     * `POST /security/disable`, behind `authenticateToken`.
     */
    disableSharedPassword() {
      if (authMode() !== 'shared-password') {
        throw new AppError('Password protection is not currently enabled', {
          code: 'AUTH_SECURITY_NOT_ACTIVE',
          statusCode: 403,
        });
      }

      dependencies.appConfig.set('auth_mode', 'none');
      bumpEpoch();

      return { success: true };
    },

    /**
     * Declaratively syncs the shared password from an env var (e.g. an
     * `APP_PASSWORD` set by a docker/CasaOS deployment) at server boot.
     * A no-op for account-mode installs (never overrides an existing
     * account) and idempotent when the password hasn't changed - only
     * bumps the epoch (revoking existing sessions) when it actually did.
     */
    async applyEnvironmentPassword(passwordInput: unknown) {
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!password || authMode() === 'account') {
        return;
      }

      let changed = false;
      const existingUser = dependencies.users.getUserByUsername(SHARED_ACCOUNT_USERNAME);
      if (existingUser) {
        const matchesCurrent = await dependencies.comparePassword(password, existingUser.password_hash);
        if (!matchesCurrent) {
          const passwordHash = await dependencies.hashPassword(password);
          dependencies.users.setPasswordHash(numericUserId(existingUser.id), passwordHash);
          changed = true;
        }
      } else {
        const passwordHash = await dependencies.hashPassword(password);
        dependencies.users.createUser(SHARED_ACCOUNT_USERNAME, passwordHash);
        changed = true;
      }

      if (authMode() !== 'shared-password') {
        dependencies.appConfig.set('auth_mode', 'shared-password');
        changed = true;
      }

      if (changed) {
        bumpEpoch();
      }
    },
  };
}
