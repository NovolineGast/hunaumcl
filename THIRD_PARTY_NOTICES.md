# Third-party notices

HUNAUMCL uses npm dependencies under their respective licenses. Exact versions and dependency integrity are recorded in `package-lock.json`; license files are retained within installed packages. A complete redistribution notice bundle must be generated when installation packages are introduced.

## Minecraft Launcher Core

`@xmcl/core` 2.16.2, `@xmcl/installer` 6.3.6, `@xmcl/asm` 1.0.1, `@xmcl/semver` 0.1.1 and `@xmcl/unzip` 2.1.2, from [Voxelum/minecraft-launcher-core-node](https://github.com/Voxelum/minecraft-launcher-core-node), are used for version resolution, launch arguments, native-library preparation, install plans, OptiFine metadata and Fabric version constraints. They are adapted behind HUNAUMCL's Node runtime interface.

Package compatibility is explicit in build/test configuration: the unshipped `@xmcl/core/utils` subpath is adapted with HUNAUMCL's own `isNotNull` implementation, and npm overrides pin `@xmcl/unzip` to a published npm-compatible dependency. HUNAUMCL also resolves the OptiFine patch plan with explicit ZIP closure and output-directory creation to support Windows transaction publication; it uses upstream public plan/generator APIs and executes the actual OptiFine Patcher.

MIT License

Copyright (c) 2023 CI010

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
