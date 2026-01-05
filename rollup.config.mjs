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
    },
    {
      file: 'dist/index.mjs',
      format: 'es',
      sourcemap: true,
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
        drop_console: false, // Keep console logs for debugging
        drop_debugger: true,
        pure_funcs: [], // Don't remove any functions
      },
      format: {
        comments: false, // Remove all comments
        preserve_annotations: true, // Keep @__PURE__ annotations
      },
      mangle: {
        keep_classnames: true, // Keep class names for better debugging
        keep_fnames: true, // Keep function names for stack traces
      },
      sourceMap: true,
    }),
  ],
}

