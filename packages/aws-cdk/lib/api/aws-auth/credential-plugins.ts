import type { AwsCredentialIdentity } from '@smithy/types';
import { debug, warning } from '../../logging';
import { CredentialProviderSource, Mode, PluginHost } from '../plugin';

/**
 * Cache for credential providers.
 *
 * Given an account and an operating mode (read or write) will return an
 * appropriate credential provider for credentials for the given account. The
 * credential provider will be cached so that multiple AWS clients for the same
 * environment will not make multiple network calls to obtain credentials.
 *
 * Will use default credentials if they are for the right account; otherwise,
 * all loaded credential provider plugins will be tried to obtain credentials
 * for the given account.
 */
export class CredentialPlugins {
  private readonly cache: { [key: string]: PluginCredentials | undefined } = {};

  public async fetchCredentialsFor(awsAccountId: string, mode: Mode): Promise<PluginCredentials | undefined> {
    const key = `${awsAccountId}-${mode}`;
    if (!(key in this.cache)) {
      this.cache[key] = await this.lookupCredentials(awsAccountId, mode);
    }
    return this.cache[key];
  }

  public get availablePluginNames(): string[] {
    return PluginHost.instance.credentialProviderSources.map((s) => s.name);
  }

  private async lookupCredentials(awsAccountId: string, mode: Mode): Promise<PluginCredentials | undefined> {
    const triedSources: CredentialProviderSource[] = [];
    // Otherwise, inspect the various credential sources we have
    for (const source of PluginHost.instance.credentialProviderSources) {
      let available: boolean;
      try {
        available = await source.isAvailable();
      } catch (e: any) {
        // This shouldn't happen, but let's guard against it anyway
        warning(`Uncaught exception in ${source.name}: ${e.message}`);
        available = false;
      }

      if (!available) {
        debug('Credentials source %s is not available, ignoring it.', source.name);
        continue;
      }
      triedSources.push(source);
      let canProvide: boolean;
      try {
        canProvide = await source.canProvideCredentials(awsAccountId);
      } catch (e: any) {
        // This shouldn't happen, but let's guard against it anyway
        warning(`Uncaught exception in ${source.name}: ${e.message}`);
        canProvide = false;
      }
      if (!canProvide) {
        continue;
      }
      debug(`Using ${source.name} credentials for account ${awsAccountId}`);
      const providerOrCreds = await source.getProvider(awsAccountId, mode);

      // Backwards compatibility: if the plugin returns a ProviderChain, resolve that chain.
      // Otherwise it must have returned credentials.
      const credentials = (providerOrCreds as any).resolvePromise
        ? await (providerOrCreds as any).resolvePromise()
        : providerOrCreds;

      // Another layer of backwards compatibility: in SDK v2, the credentials object
      // is both a container and a provider. So we need to force the refresh using getPromise.
      // In SDK v3, these two responsibilities are separate, and the getPromise doesn't exist.
      if ((credentials as any).getPromise) {
        await (credentials as any).getPromise();
      }

      return { credentials, pluginName: source.name };
    }
    return undefined;
  }
}

export interface PluginCredentials {
  readonly credentials: AwsCredentialIdentity;
  readonly pluginName: string;
}
