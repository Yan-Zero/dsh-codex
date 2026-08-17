import type { UserConfig } from 'tsdown'

export default {
    entry: {
      standard: 'src/standard.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        /^@dsh-std\//,
        '@earendil-works/pi-ai',
      ],
    },
  } satisfies UserConfig
