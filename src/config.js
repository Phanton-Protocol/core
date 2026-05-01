export const DAPP_URL = '/user';
export const RELAYER_DASHBOARD_URL = '/relayer';
export const WHITEPAPER_URL = '/e-paper';
export const EPAPER_PUBLIC_URL = 'https://phantomproto.com/e-paper';
export const GITHUB_URL = 'https://github.com/Phanton-Protocol';

/** Operator runbook (Module 7+); same content ships in repo as `RUNBOOK.md`. */
export const RUNBOOK_URL = `${GITHUB_URL}/core/blob/main/RUNBOOK.md`;

/**
 * Default relayer API (no VITE_* override). Render instance is the current stable host with production env.
 * After Hamza Vercel `backend` has the same env as Render (CORS_ORIGINS, RELAYER_PRIVATE_KEY, RPC_URL, …),
 * set VITE_API_URL / VITE_API_URLS on the website project or switch this default to that URL.
 */
export const API_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL)
  ? import.meta.env.VITE_API_URL
  : 'https://relayers-backend.onrender.com';

export const API_URLS = (() => {
  const fromMany = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URLS)
    ? String(import.meta.env.VITE_API_URLS)
        .split(/[\n,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  if (fromMany.length > 0) return Array.from(new Set(fromMany));
  return [API_URL];
})();

export const CLIENT_PROVER_WASM_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLIENT_PROVER_WASM_URL)
  ? import.meta.env.VITE_CLIENT_PROVER_WASM_URL
  : '/circuits/joinsplit.wasm';

export const CLIENT_PROVER_ZKEY_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLIENT_PROVER_ZKEY_URL)
  ? import.meta.env.VITE_CLIENT_PROVER_ZKEY_URL
  : '/circuits/joinsplit_0001.zkey';

export const BLOG_URL = 'https://medium.com/@phantomprotocol9';

export const SOCIAL_LINKS = [
  { name: 'X', href: 'https://x.com/phantompro_?s=21' },
  { name: 'Instagram', href: 'https://www.instagram.com/phantompro__' },
  { name: 'Telegram', href: 'https://t.me/+MP8lwce1gZhiZTZl' },
  { name: 'Medium', href: BLOG_URL },
];
