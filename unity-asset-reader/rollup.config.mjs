import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'

// `.` and `./texture` are browser-safe (D3): browser resolution, no node builtins external.
// `./node` may use node builtins, so it keeps them external.
const entry = ({ input, name, tsconfig, node = false }) => ({
  input,
  output: [
    { file: `dist/${name}.cjs`, format: 'cjs', sourcemap: true, exports: 'named', inlineDynamicImports: true },
    { file: `dist/${name}.mjs`, format: 'es', sourcemap: true, inlineDynamicImports: true },
  ],
  // texture2ddecoder-wasm is an optional peer: never bundled
  external: node ? [/^node:/, 'fs', 'path', 'texture2ddecoder-wasm'] : ['texture2ddecoder-wasm'],
  plugins: [
    resolve({ browser: !node, preferBuiltins: node }),
    commonjs(),
    typescript({
      tsconfig,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outputToFilesystem: true,
    }),
    terser({
      compress: { drop_debugger: true, passes: 1 },
      format: { comments: false, preserve_annotations: true },
      mangle: { keep_classnames: true, keep_fnames: true },
      sourceMap: true,
      maxWorkers: 1,
    }),
  ],
})

export default [
  entry({ input: './src/index.ts', name: 'index', tsconfig: './tsconfig.json' }),
  entry({ input: './src/texture/index.ts', name: 'texture', tsconfig: './tsconfig.json' }),
  entry({ input: './node/index.ts', name: 'node/index', tsconfig: './tsconfig.node.json', node: true }),
]
