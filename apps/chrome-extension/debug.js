const PREFIX = "[Skout Extension]";

export function log(...args) {
  console.log(PREFIX, ...args);
}

export function logError(...args) {
  console.error(PREFIX, ...args);
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
