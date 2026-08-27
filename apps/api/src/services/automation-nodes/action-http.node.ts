import type { NodeHandler } from "./types.js";

/** Config: { url: string; method?: string; headers?: Record<string,string>; body?: unknown } */
export const httpActionNodeHandler: NodeHandler = async (ctx) => {
  const { url, method = "GET", headers, body } = ctx.node.config as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };

  if (ctx.isSimulation) {
    return { output: { simulated: true, url, method } };
  }

  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const responseBody = await res.json().catch(() => null);
  return { output: { status: res.status, body: responseBody } };
};
