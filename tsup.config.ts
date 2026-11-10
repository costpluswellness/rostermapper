import { defineConfig } from 'tsup';

export default defineConfig([
	{
		// Library: import { automap } from 'rostermapper'; readWorkbook from 'rostermapper/workbook'.
		entry: { index: 'src/index.ts', workbook: 'src/workbook.ts' },
		format: ['esm'],
		platform: 'neutral',
		target: 'es2022',
		dts: true,
	},
	{
		// Command line: rostermapper (bin) or node dist/cli.js
		entry: { cli: 'src/bin.ts' },
		format: ['esm'],
		platform: 'node',
		target: 'node22',
	},
	{
		// Browser UI the CLI opens: site/ copied into dist/ui/, plus the core and SheetJS in one module.
		entry: { rostermapper: 'src/browser.ts' },
		outDir: 'dist/ui',
		format: ['esm'],
		platform: 'browser',
		target: 'es2022',
		noExternal: ['xlsx'],
		publicDir: 'site',
	},
]);
