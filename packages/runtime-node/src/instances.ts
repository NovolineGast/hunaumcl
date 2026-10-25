import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LauncherError } from '@hunaumcl/application';
import type { InstanceRepository } from '@hunaumcl/application';
import {
  createInstanceSchema,
  defaultLaunchSettings,
  launchSettingsSchema,
  updateInstanceSchema,
  componentsSchema,
  vanillaComponents,
} from '@hunaumcl/contracts';
import type {
  CreateInstanceRequest,
  InstanceComponents,
  InstanceSummary,
  UpdateInstanceRequest,
} from '@hunaumcl/contracts';
import { atomicJSON } from './json-file';

const instanceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(60),
    versionId: createInstanceSchema.shape.versionId,
    loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']),
    components: componentsSchema.default(() => ({ ...vanillaComponents })),
    createdAt: z.iso.datetime(),
    settings: launchSettingsSchema.default(() => ({ ...defaultLaunchSettings })),
  })
  .strict();
const storeSchema = z
  .object({ schemaVersion: z.literal(1), instances: z.array(instanceSchema).max(2000) })
  .strict()
  .refine((store) => new Set(store.instances.map((instance) => instance.id)).size === store.instances.length);

/** Single application writer. User data is never discarded on parse/validation errors. */
export class FileInstanceRepository implements InstanceRepository {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}
  async list(): Promise<InstanceSummary[]> {
    try {
      return storeSchema.parse(JSON.parse(await readFile(join(this.root, 'instances.json'), 'utf8')))
        .instances;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new LauncherError(
        'INSTANCE_STORE_UNREADABLE',
        '无法读取实例记录，请保留数据文件并检查内容或访问权限',
      );
    }
  }
  create(request: CreateInstanceRequest): Promise<InstanceSummary> {
    const operation = this.queue.then(async () => {
      const valid = createInstanceSchema.parse(request);
      const instances = await this.list();
      if (instances.length >= 2000) throw new LauncherError('INSTANCE_LIMIT', '实例数量已达到当前上限');
      const instance: InstanceSummary = {
        ...valid,
        id: randomUUID(),
        loader: valid.components?.loader ?? 'vanilla',
        components: valid.components ?? { ...vanillaComponents },
        createdAt: new Date().toISOString(),
        settings: { ...defaultLaunchSettings },
      };
      await mkdir(join(this.root, 'instances', instance.id, 'game'), { recursive: true });
      const temp = join(this.root, `instances.${randomUUID()}.tmp`);
      await writeFile(
        temp,
        JSON.stringify({ schemaVersion: 1, instances: [...instances, instance] }, null, 2),
        { encoding: 'utf8', flag: 'wx' },
      );
      await rename(temp, join(this.root, 'instances.json'));
      return instance;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  update(request: UpdateInstanceRequest): Promise<InstanceSummary> {
    const valid = updateInstanceSchema.parse(request);
    const operation = this.queue.then(async () => {
      const instances = await this.list();
      const instance = instances.find((instance) => instance.id === valid.instanceId);
      if (!instance) throw new LauncherError('INSTANCE_NOT_FOUND', '实例已不存在');
      Object.assign(instance, { name: valid.name, settings: valid.settings });
      await atomicJSON(join(this.root, 'instances.json'), { schemaVersion: 1, instances });
      return instance;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  configure(id: string, components: InstanceComponents): Promise<InstanceSummary> {
    const valid = componentsSchema.parse(components);
    const operation = this.queue.then(async () => {
      const instances = await this.list();
      const instance = instances.find((instance) => instance.id === id);
      if (!instance) throw new LauncherError('INSTANCE_NOT_FOUND', '实例已不存在');
      Object.assign(instance, { components: valid, loader: valid.loader });
      await atomicJSON(join(this.root, 'instances.json'), { schemaVersion: 1, instances });
      return instance;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
