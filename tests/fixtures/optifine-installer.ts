import { crc32 } from 'node:zlib';

/** Tiny synthetic installer identity, without upstream code or executable method bodies. */
export function optifineFixture(minecraft: string, release = 'G5'): Buffer {
  const u2 = (value: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value);
    return b;
  };
  const u4 = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value);
    return b;
  };
  const pool: Buffer[] = [];
  const utf8 = (value: string) => {
    const b = Buffer.from(value);
    pool.push(Buffer.concat([Buffer.from([1]), u2(b.length), b]));
    return pool.length;
  };
  const ref = (tag: number, index: number) => {
    pool.push(Buffer.concat([Buffer.from([tag]), u2(index)]));
    return pool.length;
  };
  const thisClass = ref(7, utf8('Config'));
  const superClass = ref(7, utf8('java/lang/Object'));
  const constantValue = utf8('ConstantValue');
  const descriptor = utf8('Ljava/lang/String;');
  const fields = Object.entries({ MC_VERSION: minecraft, OF_EDITION: 'HD_U', OF_RELEASE: release }).map(
    ([name, value]) => {
      const fieldName = utf8(name);
      const constant = ref(8, utf8(value));
      return Buffer.concat([
        u2(0x19),
        u2(fieldName),
        u2(descriptor),
        u2(1),
        u2(constantValue),
        u4(2),
        u2(constant),
      ]);
    },
  );
  const config = Buffer.concat([
    u4(0xcafebabe),
    u2(0),
    u2(52),
    u2(pool.length + 1),
    ...pool,
    u2(0x21),
    u2(thisClass),
    u2(superClass),
    u2(0),
    u2(fields.length),
    ...fields,
    u2(0),
    u2(0),
  ]);
  const name = Buffer.from('Config.class');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(config), 14);
  local.writeUInt32LE(config.length, 18);
  local.writeUInt32LE(config.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(config), 16);
  central.writeUInt32LE(config.length, 20);
  central.writeUInt32LE(config.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + config.length, 16);
  return Buffer.concat([local, name, config, central, name, end]);
}
