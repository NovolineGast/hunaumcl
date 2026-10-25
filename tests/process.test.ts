import { describe, expect, it } from 'vitest';
import { startGameProcess, javaArgumentFile } from '../packages/runtime-node/src/process';
import { offlineUUID, finalizeOfflineArguments } from '../packages/runtime-node/src/vanilla';
import { GameLogFormatter } from '../packages/runtime-node/src/game-log';
describe('process adapter', () => {
  it('renders XML console messages as readable text and preserves multiline traces', () => {
    const formatter = new GameLogFormatter();
    expect(formatter.format('<log4j:Event level="INFO" thread="Render thread">')).toBeUndefined();
    expect(formatter.format('<log4j:Message><![CDATA[Sound engine started]]></log4j:Message>')).toBe(
      '[INFO/Render thread] Sound engine started',
    );
    expect(formatter.format('</log4j:Event>')).toBeUndefined();
    expect(formatter.format('<log4j:Throwable><![CDATA[java.lang.Exception')).toBe(
      '[INFO/Render thread] java.lang.Exception',
    );
    expect(formatter.format('  at Main.main(Main.java:1)')).toContain('at Main.main');
    expect(formatter.format(']]></log4j:Throwable>')).toBeUndefined();
  });
  it('resolves only the known Xbox placeholders for an explicit offline identity', () => {
    expect(finalizeOfflineArguments(['--xuid', '${auth_xuid}', '--clientId', '${clientid}'])).toEqual([
      '--xuid',
      '',
      '--clientId',
      '',
    ]);
    expect(() => finalizeOfflineArguments(['${unknown}'])).toThrow('未识别');
  });
  it('preserves argument boundaries without a shell and captures split Unicode output', async () => {
    const handle = await startGameProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1]);', '中文 path & echo unsafe'],
      process.cwd(),
      (text) => text,
    );
    const lines: string[] = [];
    handle.onLog((text, stream) => {
      if (stream === 'stdout') lines.push(text);
    });
    const code = await new Promise<number | null>((resolve) => handle.onExit(resolve));
    expect(code).toBe(0);
    expect(lines).toEqual(['中文 path & echo unsafe']);
  });
  it('can stop a long-running process and observe its exit', async () => {
    const handle = await startGameProcess(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      process.cwd(),
      (text) => text,
    );
    const exited = new Promise((resolve) => handle.onExit(resolve));
    await handle.stop();
    await exited;
  });
  it('encodes Java argument files and standard offline UUIDs deterministically', () => {
    expect(javaArgumentFile(['C:\\中文 folder\\file.jar', 'a"b'])).toBe(
      '"C:\\\\中文 folder\\\\file.jar"\n"a\\"b"',
    );
    expect(offlineUUID('Notch')).toBe('b50ad385829d3141a2167e7d7539ba7f');
  });
});
