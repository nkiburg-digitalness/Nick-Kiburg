/**
 * Cross-platform demo launcher (also works on Windows, where "DEMO_MODE=true cmd" doesn't).
 *   npm run demo          seed demo data and start the server
 *   npm run seed:demo     only (re)create the demo data
 */
process.env.DEMO_MODE = 'true';

await import('./seed-demo.js');
if (!process.argv.includes('--seed-only')) {
  await import('../src/index.js');
}
