import { describe, expect, it } from 'vitest';
import { LauncherService } from '@hunaumcl/application';
import type { InstanceSummary, JavaSummary } from '@hunaumcl/contracts';
import { createInstanceSchema } from '@hunaumcl/contracts';

const instance: InstanceSummary = {
  id: '8d6e2a48-8888-4444-aaaa-0123456789ab',
  name: '我的世界',
  versionId: '1.21.1',
  loader: 'vanilla',
  createdAt: '2026-10-21T00:00:00Z',
};
function service(java: JavaSummary[] = []) {
  return new LauncherService(
    { list: async () => [instance], create: async (request) => ({ ...instance, ...request }) },
    {
      catalog: async () => ({
        latestRelease: '1.21.1',
        cached: false,
        releases: [{ id: '1.21.1', releaseTime: instance.createdAt }],
      }),
      metadata: async () => ({
        id: '1.21.1',
        mainClass: 'Main',
        javaVersion: { majorVersion: 21 },
        libraries: [
          { name: 'all' },
          { name: 'windows-only', rules: [{ action: 'allow', os: { name: 'windows' } }] },
        ],
      }),
    },
    { scan: async () => java },
    { os: 'osx', architecture: 'arm64', osVersion: '14.5', appVersion: '0.1.0' },
  );
}
describe('launch preflight', () => {
  it('filters platform libraries and requests an exact compatible runtime', async () => {
    const check = await service([
      { id: 'newer', major: 25, architecture: 'arm64', vendor: 'JDK', version: '25' },
    ]).checkLaunch(instance.id);
    expect(check.status).toBe('java-required');
    expect(check.libraryCount).toBe(1);
    expect(check.selectedJava).toBeNull();
  });
  it('returns an explicit ready preflight without credentials or process arguments', async () => {
    const check = await service([
      { id: 'matching', major: 21, architecture: 'arm64', vendor: 'JDK', version: '21' },
    ]).checkLaunch(instance.id);
    expect(check.status).toBe('compatible-java-found');
    expect(check).not.toHaveProperty('accessToken');
    expect(check).not.toHaveProperty('argv');
  });
  it('rejects stale instance IDs and unknown release versions', async () => {
    await expect(service().checkLaunch('missing')).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });
    await expect(service().createInstance({ name: 'unknown', versionId: 'unknown' })).rejects.toMatchObject({
      code: 'VERSION_UNAVAILABLE',
    });
  });
});
describe('IPC input schemas', () => {
  it('rejects blank names, traversal versions and undeclared privileged fields', () => {
    expect(createInstanceSchema.safeParse({ name: ' ', versionId: '1.21.1' }).success).toBe(false);
    expect(createInstanceSchema.safeParse({ name: 'demo', versionId: '../1.21.1' }).success).toBe(false);
    expect(
      createInstanceSchema.safeParse({ name: 'demo', versionId: '1.21.1', executable: 'cmd.exe' }).success,
    ).toBe(false);
  });
});
