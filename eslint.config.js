import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	// Global ignores - files/directories to skip
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/lib/**',
			'**/contracts/**',
			'**/pnpm-lock.yaml',
		],
	},
	// TypeScript configuration
	{
		extends: [tseslint.configs.recommended],
		files: ['src/**/*.{js,ts}'],
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ['*.config.*s'] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
	}
);
