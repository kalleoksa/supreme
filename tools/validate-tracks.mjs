// Print a validation report for every track.
//
//   npm run validate
//
// Why a script and not only a test: the test asserts a track is *not broken*, which is a
// yes/no. Tuning needs the numbers -- median grade, vertical drop, the shallowest and
// steepest windows, how many stamps are actually launch features -- and needs them without
// editing an assertion to read them. The same report backs both.
//
// Warnings are printed and do not fail. Errors fail, because an error means somewhere a run
// cannot continue.
import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const { TEST_SLOPE } = await server.ssrLoadModule('/src/track/tracks/testSlope.ts');
  const { validateSpec, formatReport } = await server.ssrLoadModule('/src/track/validate.ts');

  const specs = [TEST_SLOPE];
  let failed = 0;

  for (const spec of specs) {
    const report = validateSpec(spec);
    console.log(formatReport(report));
    console.log();
    if (!report.ok) failed++;
  }

  if (failed > 0) {
    console.error(`${failed} track(s) have errors.`);
    process.exitCode = 1;
  }
} finally {
  await server.close();
}
