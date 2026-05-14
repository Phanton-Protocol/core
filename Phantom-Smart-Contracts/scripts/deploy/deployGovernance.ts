/**
 * Deploy `contracts/_full/core/Governance.sol:Governance` (queue → 2-day delay → execute).
 *
 * Two Governance contracts exist under `contracts/_full`; Hardhat needs the FQ name below.
 *
 * ## Env (optional unless noted)
 *
 * | Variable | Default | Description |
 * |----------|---------|-------------|
 * | `PROTOCOL_TOKEN_ADDRESS` | *(required for standalone `hardhat run`)* | `ProtocolToken` (or any `IProtocolToken`) used for votes + proposal threshold. |
 * | `GOVERNANCE_OWNER` | deployer | `owner` stored on-chain (not necessarily proposer). |
 * | `GOVERNANCE_VOTING_PERIOD_BLOCKS` | `50400` | Voting window in **blocks** (~7d @ ~12s/block). |
 * | `GOVERNANCE_QUORUM` | `1000000000000000000` | Minimum **combined** for+against voting weight (token units) for `queue` to succeed. |
 * | `GOVERNANCE_MIN_PROPOSAL_THRESHOLD` | `100000000000000000000000` | Min `balanceOf(proposer)` to call `propose` — **100k tokens** (18 decimals). |
 *
 * ## After voting (operators)
 *
 * On-chain flow: once `block.number > endBlock` and the proposal passed quorum/for-vs-against checks,
 * anyone calls **`queue(id)`**, then waits **`EXECUTION_DELAY` (2 days)** from `queuedAt[id]`, then calls **`execute(id)`**.
 *
 * - **Production:** wait the full 2-day wall-clock delay (no shortcut in this script).
 * - **Tests / Hardhat:** use `@nomicfoundation/hardhat-network-helpers` `time.increase` (or `mine` blocks) between `queue` and `execute` — see governance tests when added.
 */
import type { Contract, ContractTransactionResponse, Signer } from "ethers";
import hre from "hardhat";

const GOVERNANCE_FACTORY = "contracts/_full/core/Governance.sol:Governance";

/** Default: 100k whole tokens at 18 decimals — minimum balance to `propose`. */
export const DEFAULT_GOVERNANCE_MIN_PROPOSAL_THRESHOLD = 100_000n * 10n ** 18n;

const DEFAULT_VOTING_PERIOD_BLOCKS = 50400n; // ~7 days @ ~12s/block
/** 1 token (1e18) minimum combined vote weight — raise `GOVERNANCE_QUORUM` on mainnet. */
const DEFAULT_QUORUM = 1n * 10n ** 18n;

export type DeployedGovernance = {
  governance: Contract;
  address: string;
  deployTx: ContractTransactionResponse | null;
};

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be a base-10 integer string, got: ${JSON.stringify(raw)}`);
  }
}

export type DeployGovernanceOptions = {
  /** Protocol token (votes + proposal threshold). */
  tokenAddress: string;
  /** Defaults to `signer.getAddress()`. */
  ownerAddress?: string;
  votingPeriodBlocks?: bigint;
  quorum?: bigint;
  minProposalThreshold?: bigint;
};

/**
 * Deploy Governance with the 5-parameter constructor:
 * `(token, votingPeriod, quorum, minProposalThreshold, owner)`.
 */
export async function deployCoreGovernance(
  signer: Signer,
  opts: DeployGovernanceOptions
): Promise<DeployedGovernance> {
  const { ethers } = hre;
  const owner =
    opts.ownerAddress?.trim() ||
    String(process.env.GOVERNANCE_OWNER || "").trim() ||
    (await signer.getAddress());

  const votingPeriod =
    opts.votingPeriodBlocks ?? parseBigIntEnv("GOVERNANCE_VOTING_PERIOD_BLOCKS", DEFAULT_VOTING_PERIOD_BLOCKS);
  const quorum = opts.quorum ?? parseBigIntEnv("GOVERNANCE_QUORUM", DEFAULT_QUORUM);
  const minProposalThreshold =
    opts.minProposalThreshold ??
    parseBigIntEnv("GOVERNANCE_MIN_PROPOSAL_THRESHOLD", DEFAULT_GOVERNANCE_MIN_PROPOSAL_THRESHOLD);

  const Governance = await ethers.getContractFactory(GOVERNANCE_FACTORY, signer);
  const governance = await Governance.deploy(
    opts.tokenAddress,
    votingPeriod,
    quorum,
    minProposalThreshold,
    owner
  );
  const deployTx = governance.deploymentTransaction();
  await governance.waitForDeployment();
  const address = await governance.getAddress();

  return { governance, address, deployTx };
}

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const token = String(process.env.PROTOCOL_TOKEN_ADDRESS || "").trim();
  if (!token) {
    throw new Error("PROTOCOL_TOKEN_ADDRESS is required for standalone deployGovernance.ts");
  }

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);
  console.log("Token:", token);

  const { governance, address, deployTx } = await deployCoreGovernance(deployer, { tokenAddress: token });
  if (deployTx) {
    console.log("[governance][tx] deploy:", deployTx.hash);
  }
  console.log("Governance (core):", address);

  const execDelay = await governance.getFunction("EXECUTION_DELAY")();
  console.log("EXECUTION_DELAY (seconds):", execDelay.toString());
  console.log(
    "Post-vote: call queue(proposalId) after voting ends if passed, wait EXECUTION_DELAY from queue time, then execute(proposalId)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
