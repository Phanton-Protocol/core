import { API_URL, API_URLS } from "../config";
import { filterRelayerUrlList, isBlockedRelayerBase } from "./relayerBlocklist";

let runtimeRelayerBasesRaw = "";

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function parseRelayerBases(raw) {
  if (!raw || typeof raw !== "string") return [];
  return uniq(
    raw
      .split(/[\n,\s]+/)
      .map((x) => x.trim().replace(/\/$/, ""))
      .filter(Boolean)
  );
}

export function setRuntimeRelayerBases(raw) {
  runtimeRelayerBasesRaw = typeof raw === "string" ? raw : "";
}

function isRetriableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function joinUrl(base, path) {
  return `${base.replace(/\/$/, "")}/${String(path || "").replace(/^\//, "")}`;
}

function buildTargets(path, overrideRaw) {
  const override = filterRelayerUrlList(parseRelayerBases(overrideRaw || runtimeRelayerBasesRaw)).filter(
    (x) => !isBlockedRelayerBase(x)
  );
  const defaults = filterRelayerUrlList(API_URLS?.length ? API_URLS : [API_URL]);
  const bases = uniq([...override, ...defaults].map((x) => String(x || "").replace(/\/$/, "")));
  return bases.map((base) => ({ base, url: joinUrl(base, path) }));
}

export async function relayerFetchJson(path, opts = {}, options = {}) {
  const targets = buildTargets(path, options.overrideBasesRaw);
  let lastErr = null;

  for (const target of targets) {
    try {
      const res = await fetch(target.url, {
        ...opts,
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
      });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }

      if (!res.ok) {
        // Prefer `message` when the API sets both (e.g. { error: "Proof generation failed", message: "…detail…" }).
        const msg = body?.message ?? body?.error ?? `HTTP ${res.status}`;
        const err = new Error(String(msg));
        err.status = res.status;
        err.base = target.base;
        err.url = target.url;
        if (isRetriableStatus(res.status)) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      return { data: body, base: target.base, url: target.url };
    } catch (err) {
      if (typeof err?.status === "number" && !isRetriableStatus(err.status)) {
        throw err;
      }
      lastErr = err;
    }
  }

  const msg = lastErr?.message || "Relayer request failed";
  throw new Error(`All relayers failed for ${path}: ${msg}`);
}
