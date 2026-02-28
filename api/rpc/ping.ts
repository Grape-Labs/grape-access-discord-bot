import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection } from "@solana/web3.js";
import { config } from "../../src/config.js";

function sanitizeError(err: unknown): Record<string, unknown> {
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  return {
    name: e?.name ?? "Error",
    message: e?.message ?? String(err),
    code: e?.code,
    cause: e?.cause ? String(e.cause) : undefined
  };
}

async function withTimeout<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function probeFetch(endpoint: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal
    });

    const elapsedMs = Date.now() - started;
    const text = await response.text();

    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }

    return {
      ok: response.ok,
      status: response.status,
      elapsedMs,
      body
    };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: sanitizeError(err)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeWeb3(endpoint: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const connection = new Connection(endpoint, "confirmed");
  const started = Date.now();

  try {
    const [version, slot, latestBlockhash] = await withTimeout("web3_probe", timeoutMs, () =>
      Promise.all([
        connection.getVersion(),
        connection.getSlot("confirmed"),
        connection.getLatestBlockhash("confirmed")
      ])
    );

    return {
      ok: true,
      elapsedMs: Date.now() - started,
      version,
      slot,
      latestBlockhash
    };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: sanitizeError(err)
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const endpointQuery = typeof req.query.endpoint === "string" ? req.query.endpoint : undefined;
  const endpoint = endpointQuery ?? config.rpcEndpoint;
  const timeoutMs = config.rpcRequestTimeoutMs;

  const [fetchProbe, web3Probe] = await Promise.all([
    probeFetch(endpoint, timeoutMs),
    probeWeb3(endpoint, timeoutMs)
  ]);

  const ok = Boolean(fetchProbe.ok) && Boolean(web3Probe.ok);

  res.status(ok ? 200 : 502).json({
    ok,
    endpoint,
    timeoutMs,
    probes: {
      fetch: fetchProbe,
      web3: web3Probe
    }
  });
}
