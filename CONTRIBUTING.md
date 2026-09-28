# Contributing to unity-asset-reader

Thank you for your interest in contributing to unity-asset-reader! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Building the Project](#building-the-project)
- [Running Tests](#running-tests)
- [Making Changes](#making-changes)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Coding Standards](#coding-standards)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows a code of conduct to ensure a welcoming environment for all contributors. Please be respectful and considerate in all interactions.

## Getting Started

Before contributing, please:

1. Check existing [issues](https://github.com/fatal10110/texture2ddecoder-wasm/issues) to see if your concern has already been reported
2. Read through this contributing guide
3. Familiarize yourself with the project structure

## Development Setup

### Prerequisites

- **Node.js** ≥14.0.0
- **Docker** - Required for building the WebAssembly module
- **Git** - For version control

### Installation Steps

1. **Fork and clone the repository:**

```bash
git clone https://github.com/YOUR_USERNAME/texture2ddecoder-wasm.git
cd texture2ddecoder-wasm
```

2. **Initialize git submodules:**

```bash
git submodule update --init --recursive
```

This will download the C++ texture decoder source files from the upstream repository.

3. **Install dependencies** (one root lockfile, all workspaces):

```bash
npm ci
```

4. **Verify Docker is installed:**

```bash
docker --version
```

If Docker is not installed, download it from [https://www.docker.com/get-started](https://www.docker.com/get-started)

## Building the Project

The build process has two main steps:

### Build WebAssembly Module

```bash
npm run build:wasm
```

From the repo root this delegates to `packages/decoder` (npm workspaces). This command:
- Uses Docker with Emscripten SDK to compile C++ to WebAssembly; the image is pinned to
  `emscripten/emsdk:4.0.7` (the toolchain of the published 1.2.2) so every build is the same
- Generates `packages/decoder/wasm/texture2ddecoder.js` and `.wasm`
- No local Emscripten installation needed

### Build TypeScript

```bash
npm run build:rollup
```

This bundles the decoder's TypeScript sources into `packages/decoder/dist/`.

### Build Everything

```bash
npm run build:wasm && npm run build:rollup
```

## Running Tests

### Run All Tests

```bash
npm test
```

### Test Structure

The decoder's tests are located in `packages/decoder/tests/`:
- `index.test.ts` - Unit tests for decoder functions
- `samples.test.ts` - Integration tests with real texture samples

### Adding New Tests

When adding new functionality:

1. Add corresponding tests in the appropriate test file
2. Use descriptive test names
3. Test both success and error cases
4. Ensure all tests pass before submitting

Example test structure:

```typescript
describe('New Decoder', () => {
  it('should decode valid data', async () => {
    const data = Buffer.alloc(16);
    const result = await decode_new_format(data, 4, 4);
    assert.notStrictEqual(result, null);
  });

  it('should handle invalid input gracefully', async () => {
    const result = await decode_new_format(Buffer.alloc(0), 0, 0);
    assert.strictEqual(result, null);
  });
});
```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `feature/add-new-decoder` - New features
- `fix/memory-leak` - Bug fixes
- `docs/update-readme` - Documentation updates
- `refactor/optimize-bc7` - Code refactoring

### Commit Messages

Write clear, descriptive commit messages:

```
Add BC8 decoder support

- Implement decode_bc8 function in TypeScript
- Add C++ bindings for BC8 decoding
- Include tests for BC8 format
- Update README with BC8 documentation
```

Follow the format:
- First line: Brief summary (50 characters or less)
- Blank line
- Detailed description with bullet points if needed

## Submitting Pull Requests

1. **Create a new branch** from `main`:

```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes** following the coding standards

3. **Test your changes:**

```bash
npm run build:wasm
npm run build:rollup
npm test
```

4. **Commit your changes** with clear messages

5. **Push to your fork:**

```bash
git push origin feature/your-feature-name
```

6. **Open a Pull Request** on GitHub:
   - Provide a clear title and description
   - Reference any related issues (e.g., "Fixes #123")
   - Include screenshots if applicable
   - List what was changed and why

### Pull Request Checklist

Before submitting, ensure:

- [ ] Code builds successfully (`npm run build:rollup`)
- [ ] All tests pass (`npm test`)
- [ ] No linter errors
- [ ] Documentation updated (README, JSDoc comments)
- [ ] Commit messages are clear and descriptive
- [ ] Branch is up to date with main

## Coding Standards

### TypeScript

- Use **TypeScript** for all source code
- Follow existing code style and formatting
- Use proper type annotations (avoid `any` when possible)
- Add JSDoc comments for public functions

Example:

```typescript
/**
 * Decode BC1 (DXT1) compressed texture to BGRA
 * @param data - Compressed texture data
 * @param width - Texture width in pixels
 * @param height - Texture height in pixels
 * @returns Decoded BGRA pixel data or null on failure
 */
export async function decode_bc1(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  // Implementation
}
```

### Code Style

- Use **2 spaces** for indentation
- Use **double quotes** for strings
- Add **semicolons** at the end of statements
- Keep lines under **100 characters** when practical
- Use **async/await** instead of promises chains

### Naming Conventions

- **Functions**: `camelCase` or `snake_case` (for decoder functions to match C++ API)
- **Classes**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Variables**: `camelCase`

## Continuous Integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. A `changes` job picks
the jobs by changed paths; skipped jobs report success, so all of them can be required checks.

| Status check | Runs when | What |
|---|---|---|
| `reader (node 20)`, `reader (node 22)` | `packages/{core,texture,node}/**`, `fixtures/**`, `scripts/**`, root config | `npm ci && npm run verify` (build, test, `check:browser`, no-C# guard) |
| `reader floor (node 20.19.0)`, `reader floor (node 22.12.0)` | same as `reader` | The lowest versions of the reader packages' `engines` (#172): `npm ci && npm run verify`, then `node scripts/check-node-floor.mjs` (`import` and `require()` of the three packages) |
| `decoder` | `packages/decoder/**`, lockfile | `build:wasm` (Docker), `build:rollup`, `npm test -w texture2ddecoder-wasm`; checks out submodules. Then `scripts/check-node-floor.mjs` with the WASM (`initTexture()` and decodes) on Node.js 20.19.0 and 22.12.0 |

Run the reader job locally with `npm ci && npm run verify`.

## Releases

Every package (`unity-asset-reader`, `-texture`, `-node`, `texture2ddecoder-wasm`) has its own
version. User-facing changes go under the `Unreleased` heading of their package's section in
[CHANGELOG.md](CHANGELOG.md). Do not change a `version` in a feature PR: merging a version change
to `main` publishes that package. The release procedure is in [RELEASING.md](RELEASING.md).

## Reporting Issues

### Bug Reports

When reporting bugs, please include:

1. **Description** - Clear description of the issue
2. **Steps to Reproduce** - Detailed steps to reproduce the bug
3. **Expected Behavior** - What you expected to happen
4. **Actual Behavior** - What actually happened
5. **Environment**:
   - Node.js version
   - Operating system
   - Package version
6. **Code Sample** - Minimal code to reproduce the issue
7. **Error Messages** - Any error messages or stack traces

### Feature Requests

For feature requests, describe:

1. **Use Case** - Why this feature is needed
2. **Proposed Solution** - How you envision it working
3. **Alternatives** - Any alternative solutions considered
4. **Additional Context** - Any other relevant information

## Project Structure

```
./                                # repo root: npm workspaces root (private)
├── package.json                  # workspaces: ["packages/*"]
├── docs/                         # plan, rules, GitHub Pages
└── packages/
    ├── core/                     # unity-asset-reader
    ├── texture/                  # unity-asset-reader-texture
    ├── node/                     # unity-asset-reader-node
    └── decoder/                  # texture2ddecoder-wasm
        ├── src/                  # TypeScript source (index.ts)
        ├── tests/                # index.test.ts, samples.test.ts
        ├── scripts/              # build-wasm.sh, copy-wasm.js
        ├── texture2ddecoder/     # Git submodule (C++ source)
        ├── wasm_bindings.cpp     # C++ to WASM bindings
        ├── wasm/                 # Generated WASM files
        └── dist/                 # Rollup output
```

## Additional Resources

- [WebAssembly Documentation](https://webassembly.org/)
- [Emscripten Documentation](https://emscripten.org/docs/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Original Texture2DDecoder](https://github.com/K0lb3/texture2ddecoder)

## Questions?

If you have questions that aren't covered in this guide:

1. Check existing [GitHub Discussions](https://github.com/fatal10110/texture2ddecoder-wasm/discussions)
2. Open a new discussion
3. Reach out to maintainers

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.

The reader packages are hand-ported from AssetStudio and UnityPy (MIT); the root [`NOTICE`](NOTICE) lists every upstream the repo derives from, and `packages/*/NOTICE` are the per-tarball notices. Code you port from a new upstream needs a stanza in the `NOTICE` of the package it lands in and in the root `NOTICE`, plus the one-line attribution at the top of each ported file (rule R3 in [docs/unity-asset-reader-rules.md](docs/unity-asset-reader-rules.md)).

---

Thank you for contributing to unity-asset-reader! 🎉

