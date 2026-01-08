import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'

export default {
  input: './src/index.ts',
  output: [
    {
      file: 'dist/index.cjs',
      format: 'cjs',
      sourcemap: true,
      exports: 'named',
      inlineDynamicImports: true,
    },
    {
      file: 'dist/index.mjs',
      format: 'es',
      sourcemap: true,
      inlineDynamicImports: true,
    },
  ],
  external: [
    // Node.js built-ins that should remain external
    'path',
    'fs',
    'child_process',
    'crypto',
    'url',
    'module',
    // WASM module (separate file, not bundled)
    /^\.\.\/wasm\//,
  ],
  plugins: [
    resolve({
      browser: false,
      preferBuiltins: true,
    }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outputToFilesystem: true,
    }),
    terser({
      compress: {
        drop_console: false,
        drop_debugger: true,
        pure_funcs: [],
        passes: 1, // Single pass to avoid hanging
      },
      format: {
        comments: false,
        preserve_annotations: true,
      },
      mangle: {
        keep_classnames: true,
        keep_fnames: true,
      },
      sourceMap: true,
      maxWorkers: 1, // Avoid worker issues with dynamic imports
    }),
  ],
}

