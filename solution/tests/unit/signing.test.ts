import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { validateSigningSetup } from '../../src/signing.js';
import type { Config } from '../../src/types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    role: 'executor',
    repoUrl: 'https://github.com/org/repo.git',
    repoSlug: 'org/repo',
    baseBranch: 'main',
    ghToken: 'ghp_test',
    pollIntervalSeconds: 60,
    executorId: 'executor-01',
    maxTurnsPerRun: 50,
    gitCommitSigning: 'off',
    gitSigningKey: '',
    signingKeysMount: '/mnt/host-keys',
    validationCommand: '',
    gitAuthorName: 'Bot',
    gitAuthorEmail: 'bot@test.com',
    ...overrides,
  };
}

describe('validateSigningSetup', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockExistsSync.mockReset();
  });

  it('does nothing when signing is off', async () => {
    await validateSigningSetup(makeConfig({ gitCommitSigning: 'off' }));

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('checks GPG key availability when mode is gpg', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await validateSigningSetup(makeConfig({ gitCommitSigning: 'gpg', gitSigningKey: 'ABC123' }));

    expect(mockExeca).toHaveBeenCalledWith(
      'gpg',
      ['--list-keys', 'ABC123'],
      expect.any(Object),
    );
  });

  it('throws when GPG key is not found', async () => {
    mockExeca.mockRejectedValueOnce(new Error('No public key'));

    await expect(
      validateSigningSetup(makeConfig({ gitCommitSigning: 'gpg', gitSigningKey: 'ABC123' })),
    ).rejects.toThrow(/GPG/i);
  });

  it('checks SSH key file existence when mode is ssh', async () => {
    mockExistsSync.mockReturnValue(true);

    await validateSigningSetup(makeConfig({ gitCommitSigning: 'ssh' }));

    expect(mockExistsSync).toHaveBeenCalledWith('/home/agent/.ssh/signing_key');
    expect(mockExistsSync).toHaveBeenCalledWith('/home/agent/.ssh/signing_key.pub');
  });

  it('throws when SSH private key file is missing', async () => {
    mockExistsSync.mockImplementation((path) => {
      if (String(path).endsWith('signing_key.pub')) return true;
      return false;
    });

    await expect(
      validateSigningSetup(makeConfig({ gitCommitSigning: 'ssh' })),
    ).rejects.toThrow(/SSH/i);
  });

  it('throws when SSH public key file is missing', async () => {
    mockExistsSync.mockImplementation((path) => {
      if (String(path).endsWith('signing_key.pub')) return false;
      return true;
    });

    await expect(
      validateSigningSetup(makeConfig({ gitCommitSigning: 'ssh' })),
    ).rejects.toThrow(/SSH/i);
  });
});
