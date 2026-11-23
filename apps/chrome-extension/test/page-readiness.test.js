import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";

const chrome = { runtime: { id: "t", onMessage: { addListener() {} } } };
const load = (html, url = "https://www.linkedin.com/in/jo/") => loadCapturePage({ url, html, files: ["capture/extract-common.js"], chrome });
const body = "A real profile with plenty of rendered content. ".repeat(8);

describe("waiting for LinkedIn to finish drawing the page", () => {
  it("is ready at once when the page is already drawn", async () => {
    const window = load(`<main><h1>Jo Lee</h1><p>${body}</p></main>`);
    const result = await window.SkoutCaptureExtract.waitForPageReady({ ready: () => true });
    expect(result).toEqual({ ok: true });
  });

  it("waits while the page is a skeleton and goes on as soon as the content appears", async () => {
    const window = load(`<main><div class="skeleton"></div></main>`);
    const drawn = () => Boolean(window.document.querySelector("h1")?.textContent?.trim()) && window.document.querySelector("main").textContent.length > 150;
    setTimeout(() => { window.document.querySelector("main").innerHTML = `<h1>Jo Lee</h1><p>${body}</p>`; }, 120);
    let waits = 0;
    const result = await window.SkoutCaptureExtract.waitForPageReady({ ready: drawn, intervalMs: 20, timeoutMs: 3000, onWait: () => { waits++; } });
    expect(result).toEqual({ ok: true });
    expect(waits).toBeGreaterThan(1);
  });

  it("says the page never finished, instead of reading an empty shell", async () => {
    const window = load(`<main></main>`);
    const result = await window.SkoutCaptureExtract.waitForPageReady({ ready: () => false, intervalMs: 10, timeoutMs: 60 });
    expect(result).toMatchObject({ ok: false, timedOut: true, reason: expect.stringMatching(/not finished loading/) });
  });

  it("stops with LinkedIn's own reason when the page does not exist or is not available", async () => {
    const window = load(`<main><h1>This page doesn’t exist</h1><p>Please check your URL or return to LinkedIn home.</p></main>`);
    const result = await window.SkoutCaptureExtract.waitForPageReady({ ready: () => false, intervalMs: 10, timeoutMs: 2000 });
    expect(result).toMatchObject({ ok: false, unavailable: true, reason: expect.stringMatching(/not available/) });
    expect(load(`<main><h1>Jo Lee</h1><p>${body}</p></main>`).SkoutCaptureExtract.pageUnavailable()).toBeUndefined();
    // A real profile that merely mentions "page not found" in its text is not an unavailable page.
    expect(load(`<main><h1>Jo Lee</h1><p>${body} I fixed the page not found bug. ${body}${body}${body}</p></main>`).SkoutCaptureExtract.pageUnavailable()).toBeUndefined();
  });
});
