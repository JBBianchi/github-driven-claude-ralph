import { execa } from 'execa';
import { existsSync } from 'node:fs';
import type { Config } from './types.js';

export async function validateSigningSetup(config: Config): Promise<void> {
  if (config.gitCommitSigning === 'off') {
    return;
  }

  if (config.gitCommitSigning === 'gpg') {
    try {
      await execa('gpg', ['--list-keys', config.gitSigningKey], {});
    } catch {
      throw new Error(
        `GPG signing key "${config.gitSigningKey}" not found. Was it imported by entrypoint.sh?`,
      );
    }
    return;
  }

  if (config.gitCommitSigning === 'ssh') {
    const privateKeyPath = '/home/agent/.ssh/signing_key';
    const publicKeyPath = '/home/agent/.ssh/signing_key.pub';

    if (!existsSync(privateKeyPath)) {
      throw new Error(
        `SSH signing private key not found at ${privateKeyPath}. Was it copied by entrypoint.sh?`,
      );
    }
    if (!existsSync(publicKeyPath)) {
      throw new Error(
        `SSH signing public key not found at ${publicKeyPath}. Was it copied by entrypoint.sh?`,
      );
    }
  }
}
