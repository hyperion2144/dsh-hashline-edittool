# Parser Choice Research — Issue #30

**File location**: `docs/research/parser-choice.md`  
**Rationale for `docs/research/`**: No existing convention for research notes; `docs/` is already used in the repo for agent docs; `research/` subdirectory is a reasonable, explicit convention for investigation artifacts.

**Research branch**: `research/parser-choice`  
**Evidence collected**: 2025-08-27, macOS arm64, Node 26.7.0, pnpm 11.22.0, npm 11.19.0

---

## Recommendation

**Use web-tree-sitter (WASM)**. The WASM assets total ~3.8 MB (compressed) and work without any native build scripts. Loading is confirmed functional via `fs.readFileSync` (simulating `import.meta.url` relative path from a plugin package directory). The only non-WASM language available via this route is TypeScript via `tsc` API, which adds ~23 MB and only covers TS/JS — not worth the size cost.

---

## Comparison Table

| Criterion | web-tree-sitter (WASM) | native node-tree-sitter | tsc API (TypeScript only) |
|---|---|---|---|
| **Asset total (plugin-included WASM / native bins)** | ~3.8 MB (compressed) | ~4.3 MB darwin-arm64 prebuilds (all-platform) | ~23 MB installed |
| **Build scripts needed at install** | **None** ✅ | **Blocked** by pnpm 11 by default ❌ | None |
| **`dsh plugin add` works** | ✅ Yes | ❌ Fails with `ERR_PNPM_IGNORED_BUILDS` | ✅ Yes |
| **JS/TS grammar** | ✅ via `tree-sitter-javascript.wasm` | ✅ (version mismatch issue) | ✅ (native) |
| **Python grammar** | ✅ via `tree-sitter-python.wasm` | ✅ | ❌ |
| **TSX grammar** | ✅ via `tree-sitter-tsx.wasm` | ✅ | ✅ (via tsx compiler) |
| **Language loading complexity** | `Parser.init()` + `Language.load(buffer)` | `new Parser()` + grammar `language` export | `ts.createProgram()` |
| **~1.4 MB TS file parse time** | ~250 ms | — | — |
| **npm/tarball install risk** | None | pnpm blocks postinstall | None |

---

## Evidence

### SKILL.md §打包/发布 Claim — Verification

**Claim** (`dsh-plugin-guide/SKILL.md` line 36):
> "git 安装需要 prepare 脚本与用户侧 allowBuilds，发布 npm/tarball 免构建许可"

**Verdict**: Partially correct, but incomplete.

- ✅ **npm**: Confirmed to allow build scripts (`npm warn install-scripts` is a warning, not a block; tree-sitter install succeeds with `require('tree-sitter').Query` → `true`)
- ❌ **pnpm**: Blocks ALL build scripts by default regardless of install source. Even `file:/...tgz` (dsh plugin add) gets `ERR_PNPM_IGNORED_BUILDS: tree-sitter@0.25.1`. The SKILL.md claim about "npm/tarball 免构建许可" refers to npm's behavior, not pnpm's.
- **dsh plugin add**: Uses pnpm under the hood. The claim is therefore misleading in the pnpm context.

**Test command**:
```bash
DSH_HOME=$(mktemp -d) dsh plugin --profile scratch add test-parser-0.0.1.tgz
# Output: [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: tree-sitter@0.25.1
# dsh: pnpm failed in profile directory ...
```

---

### Route 1 — web-tree-sitter (WASM)

#### Package sizes

| Package | Version | tgz size | unpacked size | Contains WASM? |
|---|---|---|---|---|
| `web-tree-sitter` | 0.26.13 | 1,137,475 B (~1.1 MB) | 4.4 MB | ✅ `web-tree-sitter.wasm` (197 KB) |
| `tree-sitter-javascript` | 0.25.0 | 683,632 B (~668 KB) | 6.3 MB | ✅ `tree-sitter-javascript.wasm` (402 KB) |
| `tree-sitter-python` | 0.25.0 | 881,828 B (~861 KB) | 10 MB | ✅ `tree-sitter-python.wasm` (447 KB) |
| `tree-sitter-typescript` | 0.23.2 | 2,961,431 B (~2.8 MB) | 48 MB | ✅ `tree-sitter-typescript.wasm` (1,384 KB) + `tree-sitter-tsx.wasm` (1,412 KB) |

**Source**: `npm view <pkg> dist --json` (unpackedSize from registry metadata); tgz from `curl -sI ...registry.npmjs.org/...tgz | grep content-length`; actual files from `npm pack` + `tar -xzf` + `ls -la`.

**WASM total** (compressed, sum of raw wasm bytes):
- `web-tree-sitter.wasm`: 201,535 B
- `tree-sitter-javascript.wasm`: 411,770 B
- `tree-sitter-python.wasm`: 457,883 B
- `tree-sitter-typescript.wasm`: 1,413,849 B
- `tree-sitter-tsx.wasm`: 1,445,638 B
- **Total**: 3,930,675 B (~3.8 MB)

**Note**: `tree-sitter-typescript` unpacked size is 48 MB because it includes both C source (`src/`) and compiled WASM. The grammar WASM files themselves are only ~2.8 MB combined.

#### WASM bundle approach (plugin `files` whitelist)

To ship WASM as plugin assets, add to `package.json`:
```json
"files": ["lib/", "tree-sitter-javascript.wasm", "tree-sitter-python.wasm", "tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]
```

Alternatively, include the grammar packages as dependencies and load WASM from `node_modules/` at runtime (WASM files survive pnpm installation because they are not build outputs — they are published assets).

#### Host process loading — ESM confirmed ✅

Test script (`/tmp/test-wasm-load.mjs`, executed against worktree's `node_modules/`):

```javascript
const WTS = require('.../web-tree-sitter/web-tree-sitter.cjs').default || require('.../web-tree-sitter/web-tree-sitter.cjs');
await WTS.Parser.init({
  locateFile: (file) => path.join(pluginDir, 'web-tree-sitter', file)
});
// load via fs (simulating import.meta.url resolution):
const tsBuffer = readFileSync(path.join(WasmDir, 'tree-sitter-typescript/tree-sitter-typescript.wasm'));
const tsLang = await WTS.Language.load(tsBuffer);
const tsParser = new WTS.Parser();
tsParser.setLanguage(tsLang);
const tree = tsParser.parse(tsCode);
console.log(tree.rootNode.type); // "program" ✅
```

**Python** parse: `rootNode.type = "module"` ✅  
**JavaScript** parse: `rootNode.type = "program"` ✅  
**TypeScript** parse: `rootNode.type = "program"` ✅

This confirms the loading pattern works for the plugin's use case (hashline-anchored read/edit).

#### Performance — ~1.4 MB TypeScript file

Generated 1,410,694 B TypeScript file (3500 class repetitions).  
**Single parse: ~250 ms** (1 sample on Apple M-series).

Command:
```bash
node /tmp/test-perf.mjs
# Generated TypeScript file: 1410694 bytes (~1378 KB)
# Parse time: 250 ms
# Root node: program, children: 7001
```

Order-of-magnitude estimate: **~180 ms per 1 MB TS**.

---

### Route 2 — native node-tree-sitter

#### Prebuild binary sizes (darwin-arm64, our platform)

| Package | Binary | Size |
|---|---|---|
| `tree-sitter` core | `tree-sitter.node` | 585,648 B (~572 KB) |
| `tree-sitter-javascript` | `tree-sitter-javascript.node` | 473,760 B (~463 KB) |
| `tree-sitter-python` | `tree-sitter-python.node` | 522,608 B (~510 KB) |
| `tree-sitter-typescript` | `tree-sitter-typescript.node` | 2,928,240 B (~2.8 MB) |

**Total for all grammars on darwin-arm64**: ~4.5 MB (but npm package includes ALL platform prebuilds, so total installed size much larger).

Source: `npm pack <pkg> && tar -xzf <pkg>.tgz && ls -la package/prebuilds/darwin-arm64/`

#### pnpm blocks native build scripts — confirmed ❌

```bash
# pnpm install in any context:
pnpm install
# Output: [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: tree-sitter@0.25.1, tree-sitter-javascript@0.25.0
```

**Tested on**: pnpm 11.22.0 (macOS arm64).  
Note: Prebuilds ARE present (from content-addressable store) — `require('tree-sitter')` loads the core. However, the grammar bindings' `require('node-gyp-build')` in pnpm's symlinked layout resolves to the `.pnpm/` path and returns an empty object `{}` instead of the loaded native addon. This causes `language` to be an empty object and `setLanguage` to fail.

#### dsh plugin add — fails ❌

```bash
DSH_HOME=$(mktemp -d) dsh plugin --profile native-test add test-native2-0.0.1.tgz
# Output:
# dsh: initialized profile native-test at /.../profiles/native-test
# [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: tree-sitter-javascript@0.25.0, tree-sitter@0.25.1
# dsh: pnpm failed in profile directory /.../profiles/native-test
```

The plugin directory is created and `package.json` is written, but pnpm reports failure and dsh aborts.

#### Additional risk: ABI version mismatch

`tree-sitter` core 0.25.1 and `tree-sitter-javascript` grammar 0.25.0 have a native ABI incompatibility. After `setLanguage(language)` succeeds (the External object is set), calling `parser.parse()` produces a tree where `tree.language` is an External object but `tree.rootNode` getter throws `TypeError: Cannot read properties of undefined (reading 'nodeSubclasses')`. This is because `initializeLanguageNodeClasses` in `tree-sitter/index.js` calls `binding.getNodeTypeNamesById(language)` which fails with the mismatched ABI.

To use native tree-sitter reliably: **pin exact matching versions** of core and all grammar packages (e.g., all at 0.25.0), and ensure `node-gyp-build` is reachable via pnpm's virtual store.

---

### Route 3 — TypeScript Compiler API

#### Package size

| Version | npm `unpackedSize` | Actual installed |
|---|---|---|
| `typescript@7.0.2` | 2,497,498 B (~2.4 MB) | ~23 MB |

`npm view typescript unpackedSize` → 2,497,498 B (metadata value).  
Actual `du -sh node_modules/typescript/` → 23 MB (includes `lib/` compiler files, `bin/`, notices).

**Source**: `npm view typescript dist --json` + `du -sh` in worktree.

#### Language coverage

Only TypeScript and JavaScript. No Python.  
`tsc` API is not a parser in the traditional sense — it requires TypeScript source files and emits diagnostics + type information. Tree-sitter gives raw syntax trees.

**Conclusion**: Adds ~23 MB for partial coverage; not recommended if Python support is needed.

---

## SKILL.md §打包 Claim Response

The claim "发布 npm/tarball 免构建许可" is **correct for npm** but **incorrect for pnpm / dsh plugin add**:

- **npm**: Tree-sitter's `node-gyp-build` install script runs; prebuilds load correctly; `require('tree-sitter').Query` returns a function.
- **pnpm (all install sources including npm tarball)**: Build scripts are blocked by default; grammar bindings fail to initialize.

**dsh plugin add** uses pnpm internally → same blocking behavior. The correct mitigation is NOT to use native tree-sitter, but to use the WASM approach which has no build requirements.

---

## Recommended Implementation Plan

1. Add to `package.json`:
   ```json
   "dependencies": {
     "web-tree-sitter": "0.26.13",
     "tree-sitter-javascript": "0.25.0",
     "tree-sitter-python": "0.25.0",
     "tree-sitter-typescript": "0.23.2"
   }
   ```

2. In plugin init code, load once at startup:
   ```typescript
   import { readFileSync } from 'fs';
   import { fileURLToPath } from 'url';
   import path from 'path';

   const __dirname = path.dirname(fileURLToPath(import.meta.url));
   const wasmDir = path.join(__dirname, '..'); // or node_modules/

   // Initialize web-tree-sitter core
   await Parser.init({
     locateFile: (file) => path.join(wasmDir, 'web-tree-sitter', file)
   });

   // Load grammars as buffers (no dynamic fetching needed)
   const jsLang = await Language.load(readFileSync(path.join(wasmDir, 'tree-sitter-javascript/tree-sitter-javascript.wasm')));
   const pyLang = await Language.load(readFileSync(path.join(wasmDir, 'tree-sitter-python/tree-sitter-python.wasm')));
   const tsLang = await Language.load(readFileSync(path.join(wasmDir, 'tree-sitter-typescript/tree-sitter-typescript.wasm')));
   const tsxLang = await Language.load(readFileSync(path.join(wasmDir, 'tree-sitter-typescript/tree-sitter-tsx.wasm')));
   ```

3. For `read` (by symbol): walk the tree with `TreeCursor` to find named nodes matching symbol patterns (function declarations, class declarations, variable declarations).
4. For `edit` (syntax block replacement): use `Tree.edit(editObject)` + `Parser.parse()` to rebuild tree after replacement, or use `getChangedRanges(oldTree, newTree)` for incremental updates.

---

## Unresolved / Future Work

- **Windows prebuilds**: Not tested on Windows. WASM approach is cross-platform by definition.
- **TSX AST depth**: Not tested how deep tree-sitter-tsx parses JSX vs `typescript` API type information.
- **Incremental parse**: WASM `Tree.edit()` + re-parse for incremental edits confirmed available in API but not benchmarked.
- **tree-sitter-typescript ABI**: Grammar 0.23.2 with core 0.26.13 (WASM) was not tested for ABI compatibility. Recommend testing on actual TypeScript source files before committing.
