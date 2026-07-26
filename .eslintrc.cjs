/**
 * ToptanPortal - ESLint Yapilandirmasi
 *
 * Tip bilgisine dayali (type-aware) denetim aciktir; `no-floating-promises` gibi
 * kurallar ancak boyle calisir. Beklemeyi unutulan bir Promise, siparis akisinda
 * "kaydedildi" denip aslinda kaydedilmemesi demektir - bu proje icin en pahali
 * hata sinifidir.
 *
 * `no-unsafe-*` ailesi kapalidir: Prisma ve Zod'un urettigi tipler bu kurallari
 * surekli tetikler ve gurultu, gercek bulgulari gizler.
 */

module.exports = {
  root: true,
  env: { node: true, es2023: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    // apps/web kendi `next lint` yapilandirmasini kullanir (React/Next kurallari
    // burada tanimli degildir); bu yuzden projeye dahil edilmez.
    project: ['./apps/api/tsconfig.json', './packages/*/tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/consistent-type-imports': [
      'warn',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],

    // Prisma/Zod turevli tiplerde surekli tetiklenir; gurultuyu keser.
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    // Sablon dizgelerinde Decimal.toString() gibi cagrilari engelliyor.
    '@typescript-eslint/restrict-template-expressions': 'off',
    // HTTP durum kodlari cerceve sinirlarinda duz sayiya donusur; HttpStatus
    // ile karsilastirma bilincli ve dogrudur.
    '@typescript-eslint/no-unsafe-enum-comparison': 'off',

    'no-console': ['error', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
  },
  overrides: [
    {
      // Testlerde mock kurulumu kacinilmaz olarak tip zorlamasi gerektirir.
      files: ['**/*.spec.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/unbound-method': 'off',
      },
    },
    {
      // Bakim betikleri dogrudan konsola yazar.
      files: ['**/src/scripts/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    '.next',
    'coverage',
    'apps/web',
    '*.cjs',
    '*.config.js',
  ],
};
