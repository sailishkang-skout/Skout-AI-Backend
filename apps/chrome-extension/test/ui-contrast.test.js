import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const css = read("popup.css");
const panelCss = read("panel.css");

const tokens = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((match) => [match[1], match[2]]));
const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [hi, lo] = [luminance(tokens[a]), luminance(tokens[b])].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe("the extension is readable (WCAG AA)", () => {
  it("defines every colour as a token", () => {
    for (const name of ["bg", "surface", "surface-2", "text", "text-2", "muted", "brand", "on-brand", "link", "control", "disabled-bg", "disabled-text"]) expect(tokens[name], name).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("text on every background it appears on has at least 4.5:1 contrast (7:1 for primary text)", () => {
    const text = [
      ["text", "bg", 7], ["text", "surface", 7], ["text", "surface-2", 7], ["text", "control", 7],
      ["text-2", "surface", 7], ["text-2", "surface-2", 4.5], ["muted", "surface", 7], ["muted", "surface-2", 4.5], ["muted", "bg", 4.5],
      ["link", "surface", 4.5], ["link", "bg", 4.5], ["on-brand", "brand", 4.5], ["on-brand", "brand-hover", 4.5],
      ["success", "surface", 4.5], ["warning", "surface", 4.5], ["danger-strong", "surface", 4.5], ["danger", "surface", 4.5],
      ["success-text", "success-bg", 4.5], ["warning-text", "warning-bg", 4.5], ["danger-text", "danger-bg", 4.5], ["danger-text", "danger-hover", 4.5], ["info-text", "info-bg", 4.5],
      ["warning", "warning-bg", 4.5], ["disabled-text", "disabled-bg", 4.5], ["text", "control-hover", 4.5],
    ];
    const failures = text.filter(([fg, bg, min]) => ratio(fg, bg) < min).map(([fg, bg, min]) => `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)} < ${min}`);
    expect(failures).toEqual([]);
  });

  it("the edges of inputs and buttons are visible against the page (3:1)", () => {
    expect(ratio("border-strong", "surface")).toBeGreaterThanOrEqual(3);
    expect(ratio("border-strong", "surface-2")).toBeGreaterThanOrEqual(3);
    expect(ratio("focus", "surface")).toBeGreaterThanOrEqual(3);
  });

  it("styles disabled controls so they are obviously disabled but still legible", () => {
    expect(css).toMatch(/button:disabled[\s\S]*?cursor: not-allowed/);
    expect(css).toMatch(/button:disabled[\s\S]*?color: var\(--disabled-text\)/);
    expect(css).not.toMatch(/opacity:\s*0?\.[0-6]/);
    expect(panelCss).not.toMatch(/opacity:\s*0?\.[0-6]/);
  });

  it("panel.css uses the tokens, never a raw colour, and none of the old faded greys or light-mode colours remain anywhere", () => {
    expect(panelCss.match(/#[0-9a-fA-F]{3,6}\b/g) || []).toEqual([]);
    const faded = ["#475569", "#64748b", "#666", "#e6e6e6", "#f1f7fe", "#c7dcf5", "#8a4b00", "#0a66c2", "#b42318"];
    for (const file of ["popup.css", "panel.css", "content-script.js", "panel-app.js", "capture-panel.js", "sidepanel.html", "popup.html"]) {
      const source = read(file).toLowerCase();
      for (const color of faded) expect(source.includes(color), `${file} still uses ${color}`).toBe(false);
    }
  });

  it("keeps text at a readable size", () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g), ...panelCss.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
  });

  it("shows the Skout logo in the side panel and the popup", () => {
    for (const file of ["sidepanel.html", "popup.html"]) expect(read(file)).toMatch(/<img class="brand-logo" src="icons\/icon48\.png"/);
  });

  it("has no Intelligence, System state or Enterprise control sections, and nothing still writes into them", () => {
    const html = read("sidepanel.html");
    for (const label of ["Intelligence", "System state", "Enterprise control"]) expect(html).not.toContain(label);
    expect(html).not.toMatch(/id="vision-(policy|freshness|confidence|evidence|system|side-effects|audit)/);
    expect(read("panel-app.js")).not.toMatch(/updateVision|visionSystemState|visionPolicyChip/);
  });
});
