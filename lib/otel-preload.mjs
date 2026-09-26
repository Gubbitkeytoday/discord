// ============================================================================
//  OpenTelemetry preload.
//
//    node --import ./lib/otel-preload.mjs server.js
//    NODE_OPTIONS="--import ./lib/otel-preload.mjs" npm start
//
//  The Docker image always starts through this file. It is a no-op — nothing
//  beyond this module is loaded — unless OTEL_EXPORTER_OTLP_ENDPOINT (or the
//  per-signal traces/metrics endpoint) is set, so leaving it in the command
//  line costs nothing on a deployment without a collector.
//
//  When enabled it must run before the application's imports are evaluated:
//  auto-instrumentation works by patching `http`, `express` and `pg` as they
//  load, and in an ES-module app that needs a loader hook registered first.
//  The hook is registered in "only what is hooked" mode, so every other module
//  loads untouched.
// ============================================================================

import { register } from 'node:module';

const env = process.env;
const enabled = String(env.OTEL_SDK_DISABLED).toLowerCase() !== 'true'
  && Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);

if (enabled) {
  try {
    const { createAddHookMessageChannel } = await import('import-in-the-middle');
    const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
    register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

    const { startOtel } = await import('./telemetry.js');
    await startOtel({ preloaded: true });
    // The instrumentations have told the loader which modules to wrap; wait
    // until it has acknowledged them before the app's imports run.
    await waitForAllMessagesAcknowledged();
  } catch (err) {
    // Observability must never stop the app from starting.
    process.stderr.write(`otel-preload: disabled (${err?.message ?? err})\n`);
  }
}
