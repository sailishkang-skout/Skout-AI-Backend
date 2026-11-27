import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `metaUrl` (pass `import.meta.url`) is the script node/tsx was started
 * with, so a CLI file can run its `main()` only when executed, never when a test imports it.
 * Don't use a NODE_ENV check for this: the repo .env sets NODE_ENV=development, which ran `main()`
 * (and its process.exit) inside vitest.
 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(entry) === normalize(fileURLToPath(metaUrl));
}
