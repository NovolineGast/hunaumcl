import { describe, expect, it } from 'vitest';
import {
  evaluateRules,
  inheritanceChain,
  matchesJava,
  selectJava,
  toGameOS,
  toJavaArchitecture,
} from '@hunaumcl/domain';
import type { RuleEnvironment } from '@hunaumcl/domain';
import { nativeLibraryArchitecture } from '@hunaumcl/domain';

const env: RuleEnvironment = {
  os: 'osx',
  osVersion: '14.5',
  architecture: 'aarch64',
  features: { has_custom_resolution: true },
};

describe('Mojang rules', () => {
  it('distinguishes absent rules from an empty rules array', () => {
    expect(evaluateRules(undefined, env)).toBe(true);
    expect(evaluateRules([], env)).toBe(false);
  });
  it('uses the last matching action for OS and architecture', () => {
    const rules = [
      { action: 'allow', os: { name: 'osx' } },
      { action: 'disallow', os: { arch: 'aarch64' } },
    ] as const;
    expect(evaluateRules(rules, env)).toBe(false);
    expect(evaluateRules([...rules, { action: 'allow', os: { version: '^14\\.' } }], env)).toBe(true);
  });
  it('matches feature values, including missing=false', () => {
    expect(
      evaluateRules(
        [{ action: 'allow', features: { is_demo_user: false, has_custom_resolution: true } }],
        env,
      ),
    ).toBe(true);
    expect(evaluateRules([{ action: 'allow', features: { is_demo_user: true } }], env)).toBe(false);
  });
  it('does not accept an invalid OS regex', () => {
    expect(evaluateRules([{ action: 'allow', os: { version: '[' } }], env)).toBe(false);
  });
});

describe('Java and target environments', () => {
  it('distinguishes native classifiers that share only an OS rule', () => {
    expect(nativeLibraryArchitecture('org.lwjgl:lwjgl:3.3.3:natives-windows-arm64')).toBe('arm64');
    expect(nativeLibraryArchitecture('org.lwjgl:lwjgl:3.3.3:natives-windows-x86')).toBe('ia32');
    expect(nativeLibraryArchitecture('org.lwjgl:lwjgl:3.3.3:natives-macos')).toBe('x64');
    expect(nativeLibraryArchitecture('org.lwjgl:lwjgl:3.3.3')).toBeUndefined();
  });
  it('keeps compatible majors discrete and intersects bounds', () => {
    expect(matchesJava({ major: 11, architecture: 'x64' }, { compatibleMajors: [8, 17] })).toBe(false);
    expect(matchesJava({ major: 17, architecture: 'x64' }, { compatibleMajors: [8, 17], maxMajor: 16 })).toBe(
      false,
    );
    expect(matchesJava({ major: 8, architecture: 'x64' }, { compatibleMajors: [8, 17] })).toBe(true);
  });
  it('does not silently select a higher major or a different native architecture', () => {
    const candidates = [
      { major: 25, architecture: 'arm64' },
      { major: 21, architecture: 'x64' },
    ];
    expect(selectJava(candidates, 21, 'arm64')).toBeUndefined();
    expect(selectJava(candidates, 21, 'x64')).toEqual(candidates[1]);
  });
  it('maps Node platform names to Mojang names', () => {
    expect(toGameOS('darwin')).toBe('osx');
    expect(toGameOS('win32')).toBe('windows');
    expect(toJavaArchitecture('arm64')).toBe('aarch64');
    expect(() => toGameOS('android')).toThrow();
  });
});

describe('version inheritance', () => {
  it('resolves parents before children', () => {
    expect(
      inheritanceChain(
        'modded',
        new Map([
          ['modded', { id: 'modded', inheritsFrom: 'base' }],
          ['base', { id: 'base' }],
        ]),
      ),
    ).toEqual(['base', 'modded']);
  });
  it('reports a three-node cycle and missing parent', () => {
    const cycle = new Map([
      ['A', { id: 'A', inheritsFrom: 'B' }],
      ['B', { id: 'B', inheritsFrom: 'C' }],
      ['C', { id: 'C', inheritsFrom: 'A' }],
    ]);
    expect(() => inheritanceChain('A', cycle)).toThrow('A → B → C → A');
    expect(() => inheritanceChain('missing', cycle)).toThrow('Missing inherited version');
  });
});
