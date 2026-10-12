import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

export const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const readSource = (file) => readFileSync(resolve(extensionRoot, file), "utf8");

/** Loads capture content scripts into a rendered-page fixture, the way Chrome injects them. */
export function loadCapturePage({ url, html, files, chrome }) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: "outside-only" });
  const { window } = dom;
  // jsdom has no layout engine; every fixture element counts as visible, left of the sidebar.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 200, height: 20, top: 0, left: 10, right: 210, bottom: 20 };
  };
  window.chrome = chrome ?? { runtime: { id: "test-extension", onMessage: { addListener() {} }, sendMessage: async () => undefined } };
  for (const file of files) window.eval(readSource(file));
  return window;
}
