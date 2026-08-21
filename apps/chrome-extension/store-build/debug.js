const PREFIX = "[Skout Extension]";

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function log(...args) {
  console.log(`${PREFIX} ${ts()}`, ...args);
}

export function logError(...args) {
  console.error(`${PREFIX} ${ts()}`, ...args);
}

/**
 * Time an async step and log start/done/fail with elapsed ms. Returns the
 * awaited value so it can wrap any promise inline:
 *   const x = await timeStep("activate", () => activateProspect(p));
 */
export async function timeStep(label, fn) {
  const start = Date.now();
  log(`▶ ${label} …`);
  try {
    const result = await fn();
    log(`✓ ${label} (${Date.now() - start}ms)`);
    return result;
  } catch (error) {
    logError(`✗ ${label} (${Date.now() - start}ms):`, error instanceof Error ? error.message : error);
    throw error;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      globalThis.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
