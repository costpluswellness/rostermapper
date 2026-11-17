import { defineConfig } from 'tsup';

export default defineConfig([
	{
		// Library: rostermapper (pure), rostermapper/workbook (SheetJS), rostermapper/node (files and live lookups).
		entry: { index: 'src/index.ts', workbook: 'src/workbook.ts', node: 'src/node.ts' },
		format: ['esm'],
		platform: 'node',
		target: 'node22',
		dts: true,
	},
	{
		// Command line: rostermapper (bin) or node dist/cli.js
		entry: { cli: 'src/cli/bin.ts' },
		format: ['esm'],
		platform: 'node',
		target: 'node22',
	},
	{
		// Browser UI the CLI serves: ui/ copied into dist/ui/, plus the library and SheetJS in one module.
		entry: { rostermapper: 'src/browser.ts' },
		outDir: 'dist/ui',
		format: ['esm'],
		platform: 'browser',
		target: 'es2022',
		noExternal: ['xlsx'],
		publicDir: 'ui',
	},
]);
