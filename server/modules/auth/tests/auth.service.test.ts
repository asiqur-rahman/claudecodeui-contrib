import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createInMemoryAppConfig(initial: Record<string, string> = {}): AuthDependencies['appConfig'] {
  const store = new Map(Object.entries(initial));
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    appConfig: createInMemoryAppConfig(),
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
      setPasswordHash: () => undefined,
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('refreshSession carries the caller\'s token epoch forward unchanged', () => {
  let tokenEpoch: string | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (_user, epoch) => {
      tokenEpoch = epoch;
      return 'replacement-token';
    },
  }));

  service.refreshSession({ id: 7, username: 'alice' }, '3');

  assert.equal(tokenEpoch, '3');
});

test('createOpenSession refuses when the installation is not in open mode', async () => {
  const service = createAuthService(createDependencies({
    appConfig: createInMemoryAppConfig({ auth_mode: 'account' }),
  }));

  await assert.rejects(
    service.createOpenSession(),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_SECURITY_NOT_OPEN',
  );
});

test('createOpenSession provisions the hidden account once and reuses it afterwards', async () => {
  const created: string[] = [];
  let existingUser: { id: number; username: string; password_hash: string } | undefined;
  const service = createAuthService(createDependencies({
    appConfig: createInMemoryAppConfig({ auth_mode: 'none' }),
    users: {
      hasUsers: () => Boolean(existingUser),
      createUser: (username, passwordHash) => {
        created.push(username);
        existingUser = { id: 1, username, password_hash: passwordHash };
        return existingUser;
      },
      getUserByUsername: (username) => (existingUser?.username === username ? existingUser : undefined),
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
  }));

  const first = await service.createOpenSession();
  const second = await service.createOpenSession();

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.deepEqual(created, ['__app_shared_account__']);
});

test('unlockWithSharedPassword rejects an incorrect password', async () => {
  const service = createAuthService(createDependencies({
    appConfig: createInMemoryAppConfig({ auth_mode: 'shared-password' }),
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: '__app_shared_account__', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    comparePassword: async () => false,
  }));

  await assert.rejects(
    service.unlockWithSharedPassword('wrong'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
});

test('unlockWithSharedPassword issues a token on a correct password', async () => {
  const service = createAuthService(createDependencies({
    appConfig: createInMemoryAppConfig({ auth_mode: 'shared-password' }),
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: '__app_shared_account__', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    comparePassword: async () => true,
    generateToken: () => 'unlocked-token',
  }));

  const result = await service.unlockWithSharedPassword('correct');

  assert.equal(result.token, 'unlocked-token');
});

test('enableSharedPassword refuses to touch an account-mode installation', async () => {
  const service = createAuthService(createDependencies({
    appConfig: createInMemoryAppConfig({ auth_mode: 'account' }),
  }));

  await assert.rejects(
    service.enableSharedPassword('newpassword', undefined),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_SECURITY_ACCOUNT_MODE',
  );
});

test('enableSharedPassword provisions the hidden account and bumps the epoch on first enable', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'none' });
  const service = createAuthService(createDependencies({
    appConfig,
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
  }));

  const result = await service.enableSharedPassword('newpassword', undefined);

  assert.equal(result.success, true);
  assert.equal(appConfig.get('auth_mode'), 'shared-password');
  assert.equal(appConfig.get('auth_security_epoch'), '1');
});

test('enableSharedPassword requires the correct current password to rotate an existing one', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'shared-password', auth_security_epoch: '1' });
  const existingUser = { id: 1, username: '__app_shared_account__', password_hash: 'old-hash' };
  const service = createAuthService(createDependencies({
    appConfig,
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => existingUser,
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    comparePassword: async (password) => password === 'correct-current',
  }));

  await assert.rejects(
    service.enableSharedPassword('newpassword', 'wrong-current'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_SECURITY_CURRENT_PASSWORD_INVALID',
  );

  const result = await service.enableSharedPassword('newpassword', 'correct-current');
  assert.equal(result.success, true);
  assert.equal(appConfig.get('auth_security_epoch'), '2');
});

test('disableSharedPassword refuses unless shared-password mode is active', () => {
  const service = createAuthService(createDependencies({
    appConfig: createInMemoryAppConfig({ auth_mode: 'none' }),
  }));

  assert.throws(
    () => service.disableSharedPassword(),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_SECURITY_NOT_ACTIVE',
  );
});

test('disableSharedPassword flips the mode back to open and bumps the epoch', () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'shared-password', auth_security_epoch: '1' });
  const service = createAuthService(createDependencies({ appConfig }));

  const result = service.disableSharedPassword();

  assert.equal(result.success, true);
  assert.equal(appConfig.get('auth_mode'), 'none');
  assert.equal(appConfig.get('auth_security_epoch'), '2');
});

test('applyEnvironmentPassword does nothing for an account-mode installation', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'account' });
  let createCalled = false;
  const service = createAuthService(createDependencies({
    appConfig,
    users: {
      hasUsers: () => true,
      createUser: () => { createCalled = true; throw new Error('unused'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
  }));

  await service.applyEnvironmentPassword('env-password');

  assert.equal(createCalled, false);
  assert.equal(appConfig.get('auth_mode'), 'account');
});

test('applyEnvironmentPassword does nothing when no password is provided', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'none' });
  const service = createAuthService(createDependencies({ appConfig }));

  await service.applyEnvironmentPassword(undefined);

  assert.equal(appConfig.get('auth_mode'), 'none');
  assert.equal(appConfig.get('auth_security_epoch'), null);
});

test('applyEnvironmentPassword provisions the hidden account and enables shared-password mode on first sync', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'none' });
  let created: { username: string; passwordHash: string } | undefined;
  const service = createAuthService(createDependencies({
    appConfig,
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        created = { username, passwordHash };
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    hashPassword: async (password) => `hashed:${password}`,
  }));

  await service.applyEnvironmentPassword('env-password');

  assert.equal(created?.username, '__app_shared_account__');
  assert.equal(created?.passwordHash, 'hashed:env-password');
  assert.equal(appConfig.get('auth_mode'), 'shared-password');
  assert.equal(appConfig.get('auth_security_epoch'), '1');
});

test('applyEnvironmentPassword is a no-op when the password already matches (no epoch bump)', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'shared-password', auth_security_epoch: '3' });
  let setPasswordHashCalled = false;
  const service = createAuthService(createDependencies({
    appConfig,
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: '__app_shared_account__', password_hash: 'existing-hash' }),
      updateLastLogin: () => undefined,
      setPasswordHash: () => { setPasswordHashCalled = true; },
    },
    comparePassword: async (password, hash) => password === 'env-password' && hash === 'existing-hash',
  }));

  await service.applyEnvironmentPassword('env-password');

  assert.equal(setPasswordHashCalled, false);
  assert.equal(appConfig.get('auth_security_epoch'), '3');
});

test('applyEnvironmentPassword rotates the hash and bumps the epoch when the env password changed', async () => {
  const appConfig = createInMemoryAppConfig({ auth_mode: 'shared-password', auth_security_epoch: '3' });
  const service = createAuthService(createDependencies({
    appConfig,
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: '__app_shared_account__', password_hash: 'old-hash' }),
      updateLastLogin: () => undefined,
      setPasswordHash: () => undefined,
    },
    comparePassword: async () => false,
    hashPassword: async (password) => `hashed:${password}`,
  }));

  await service.applyEnvironmentPassword('new-env-password');

  assert.equal(appConfig.get('auth_security_epoch'), '4');
});
