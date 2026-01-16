const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5050";

export async function getQuote(payload) {
  const res = await fetch(`${API_URL}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createIntent(payload) {
  const res = await fetch(`${API_URL}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitSwap(payload) {
  const res = await fetch(`${API_URL}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getReceipt(intentId) {
  const res = await fetch(`${API_URL}/receipt/${intentId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getRelayer() {
  const res = await fetch(`${API_URL}/relayer`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitDeposit(payload) {
  const res = await fetch(`${API_URL}/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitWithdraw(payload) {
  const res = await fetch(`${API_URL}/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
