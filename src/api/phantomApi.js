import { relayerFetchJson } from '../lib/relayerHttp';
const enterpriseHeaders = () => {
  const key = localStorage.getItem('phantom_enterprise_api_key') || '';
  return key ? { 'X-Enterprise-API-Key': key } : {};
};

async function req(path, opts = {}) {
  const { data } = await relayerFetchJson(path, opts);
  return data;
}

export async function getRelayer() {
  return req('/relayer');
}

export async function getRelayerConfig() {
  return req('/config');
}

export async function createReportingKey(walletAddress, signature, message) {
  return req('/tax-reporting-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: walletAddress, signature, message }),
  });
}

export async function revokeReportingKey(walletAddress, signature, message) {
  return req('/tax-reporting-keys/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: walletAddress, signature, message }),
  });
}

export async function getTaxExport(key) {
  const qs = new URLSearchParams({ key: String(key || '') });
  return req(`/tax-export?${qs.toString()}`, {
    headers: { 'X-Tax-Reporting-Key': key },
  });
}

export async function getFhePublicKey() {
  return req('/fhe/public-key');
}

export async function encryptFhe(payload) {
  return req('/fhe/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function submitFheOrder(orderPayload) {
  return req('/fhe/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderPayload),
  });
}

export async function createPayrollRun(payload) {
  return req('/payroll/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...enterpriseHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function listPayrollRuns() {
  return req('/payroll/runs', { headers: enterpriseHeaders() });
}

export async function approvePayrollRun(runId) {
  return req(`/payroll/runs/${runId}/approve`, { method: 'POST', headers: enterpriseHeaders() });
}

export async function executePayrollRun(runId) {
  return req(`/payroll/runs/${runId}/execute`, { method: 'POST', headers: enterpriseHeaders() });
}

export async function screenCompliance(payload) {
  return req('/compliance/screen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...enterpriseHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function createLedgerAccount(payload) {
  return req('/ledger/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...enterpriseHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function postLedgerEntry(payload) {
  return req('/ledger/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...enterpriseHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function listLedgerEntries(tenantId) {
  const qs = new URLSearchParams();
  if (tenantId) qs.set('tenantId', tenantId);
  const path = qs.toString() ? `/ledger/entries?${qs.toString()}` : '/ledger/entries';
  return req(path, { headers: enterpriseHeaders() });
}

export async function createGovernanceProposal(payload) {
  return req('/governance/proposals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...enterpriseHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function voteOnProposal(proposalId, payload) {
  return req(`/governance/proposals/${proposalId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...enterpriseHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function getGovernanceOverview() {
  return req('/governance/overview', { headers: enterpriseHeaders() });
}

export async function getAuditEvents() {
  return req('/audit/events', { headers: enterpriseHeaders() });
}

export async function getTokenomicsMetrics() {
  return req('/tokenomics/metrics', { headers: enterpriseHeaders() });
}

export async function getSeeConfig() {
  return req('/see/config');
}

export async function createInternalIntent(payload) {
  return req("/intent/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function cancelInternalIntent(payload) {
  return req("/intent/internal/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getInternalIntent(orderId) {
  return req(`/intent/internal/${orderId}`);
}

export async function listInternalIntents({ status, limit = 50, offset = 0 } = {}) {
  const qs = new URLSearchParams();
  if (status) qs.set("status", String(status));
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  return req(`/intent/internal?${qs.toString()}`);
}

export async function settlementStart(matchHash, payload = {}) {
  return req(`/settlement/internal/${matchHash}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function settlementRetry(matchHash, payload = {}) {
  return req(`/settlement/internal/${matchHash}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function settlementStatus(matchHash) {
  return req(`/settlement/internal/${matchHash}/status`);
}

export async function complianceByOrder(orderId) {
  return req(`/compliance/internal/order/${orderId}/decisions`);
}

export async function complianceByMatch(matchHash) {
  return req(`/compliance/internal/match/${matchHash}/decisions`);
}

export async function complianceByExecution(executionId) {
  return req(`/compliance/internal/execution/${executionId}/decisions`);
}
