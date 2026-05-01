/** Retired / broken relayer hosts — never call these (CORS or dead deployments). */
const RAW_BLOCKED = [
  "https://backend-ashy-ten-75.vercel.app",
  "https://backend-seven-vert-86.vercel.app",
];

export function normalizeRelayerBase(u) {
  return String(u || "")
    .trim()
    .replace(/\/$/, "")
    .toLowerCase();
}

export const BLOCKED_RELAYER_NORMALIZED = new Set(RAW_BLOCKED.map(normalizeRelayerBase));

export function isBlockedRelayerBase(u) {
  return BLOCKED_RELAYER_NORMALIZED.has(normalizeRelayerBase(u));
}

export function filterRelayerUrlList(urls) {
  return (Array.isArray(urls) ? urls : []).filter((x) => x && !isBlockedRelayerBase(x));
}
