/**
 * Shared deploy helpers for verifiers + swap adaptor (Module 1 profiles).
 */
import { ethers } from "hardhat";
import { deploymentTxHash } from "./deploymentRecord";
import {
  assertExpectedChainId,
  assertExperimentalDeployBlocked,
  assertProductionNetworkBinding,
  resolveProductionOracleAndDex,
} from "./networkConfig";

export type DeployProfileName = "dev" | "staging" | "production";

export function getDeployProfile(): DeployProfileName {
  const p = (process.env.DEPLOY_PROFILE || "dev").toLowerCase();
  if (p === "staging" || p === "production") return p as DeployProfileName;
  return "dev";
}

export function useMockInfrastructure(): boolean {
  return getDeployProfile() === "dev";
}

/** Refuse accidental mock deploy when operator sets a force flag on staging/production. */
export function assertDeployProfileForbidsForcedMocks(): void {
  const p = getDeployProfile();
  if (p !== "dev" && process.env.FORCE_MOCK_INFRASTRUCTURE === "true") {
    throw new Error(
      "FORCE_MOCK_INFRASTRUCTURE=true is forbidden when DEPLOY_PROFILE is staging or production (Module 7 gate)."
    );
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`DEPLOY_PROFILE is staging/production: required env ${name} is missing`);
  }
  return v.trim();
}

export type InfraAddresses = {
  joinSplit: string;
  portfolio: string;
  threshold: string;
  swapAdaptor: string;
  /** Set when not using mocks (for deployments.json) */
  groth16Verifier?: string;
  mockJoinSplit?: string;
  mockThreshold?: string;
  mockSwapAdaptor?: string;
  /** Contract-creation tx hashes (keys align with deployments.json contract names). */
  deploymentTxs: Record<string, string>;
};

export async function deployVerifiersAndSwapAdaptor(): Promise<InfraAddresses> {
  assertExperimentalDeployBlocked();
  assertDeployProfileForbidsForcedMocks();
  if (useMockInfrastructure()) {
    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const joinSplitVerifier = await MockVerifier.deploy();
    await joinSplitVerifier.waitForDeployment();
    const joinSplitAddr = await joinSplitVerifier.getAddress();
    const joinSplitTx = deploymentTxHash(joinSplitVerifier);

    const thresholdVerifier = await MockVerifier.deploy();
    await thresholdVerifier.waitForDeployment();
    const thresholdAddr = await thresholdVerifier.getAddress();
    const thresholdTx = deploymentTxHash(thresholdVerifier);

    const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
    const swapAdaptor = await MockSwapAdaptor.deploy();
    await swapAdaptor.waitForDeployment();
    const swapAdaptorAddr = await swapAdaptor.getAddress();
    const swapAdaptorTx = deploymentTxHash(swapAdaptor);

    const deploymentTxs: Record<string, string> = {
      joinSplitVerifier: joinSplitTx,
      portfolioVerifier: joinSplitTx,
      thresholdVerifier: thresholdTx,
      swapAdaptor: swapAdaptorTx,
    };

    return {
      joinSplit: joinSplitAddr,
      portfolio: joinSplitAddr,
      threshold: thresholdAddr,
      swapAdaptor: swapAdaptorAddr,
      mockJoinSplit: joinSplitAddr,
      mockThreshold: thresholdAddr,
      mockSwapAdaptor: swapAdaptorAddr,
      deploymentTxs,
    };
  }

  const profile = getDeployProfile();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log("Deploy profile:", profile, "(real Groth16 + PancakeSwapAdaptor)", "chainId:", chainId);

  assertProductionNetworkBinding(chainId, profile);
  const expectedChainId = process.env.EXPECTED_CHAIN_ID?.trim();
  if (expectedChainId) {
    assertExpectedChainId(chainId, Number(expectedChainId));
  }

  const deploymentTxs: Record<string, string> = {};

  let groth16Addr = process.env.JOIN_SPLIT_GROTH16_ADDRESS?.trim();
  if (!groth16Addr) {
    const Groth16 = await ethers.getContractFactory(
      "contracts/_full/verifiers/JoinSplitVerifier.sol:Groth16Verifier"
    );
    const groth16 = await Groth16.deploy();
    await groth16.waitForDeployment();
    groth16Addr = await groth16.getAddress();
    deploymentTxs.groth16Verifier = deploymentTxHash(groth16);
    console.log("Deployed Groth16Verifier at", groth16Addr);
  } else {
    console.log("Using existing Groth16Verifier at", groth16Addr);
  }

  const Adapter = await ethers.getContractFactory("Groth16VerifierAdapter");
  const adapter = await Adapter.deploy(groth16Addr);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  const adapterTx = deploymentTxHash(adapter);
  deploymentTxs.joinSplitVerifier = adapterTx;
  deploymentTxs.portfolioVerifier = adapterTx;
  deploymentTxs.thresholdVerifier = adapterTx;
  console.log("Deployed Groth16VerifierAdapter at", adapterAddr);

  const { pancakeRouter: router, wbnb } = resolveProductionOracleAndDex(chainId);
  const Pancake = await ethers.getContractFactory("PancakeSwapAdaptor");
  const swapAdaptor = await Pancake.deploy(router, wbnb);
  await swapAdaptor.waitForDeployment();
  const swapAdaptorAddr = await swapAdaptor.getAddress();
  deploymentTxs.swapAdaptor = deploymentTxHash(swapAdaptor);
  console.log("Deployed PancakeSwapAdaptor at", swapAdaptorAddr);

  return {
    joinSplit: adapterAddr,
    portfolio: adapterAddr,
    threshold: adapterAddr,
    swapAdaptor: swapAdaptorAddr,
    groth16Verifier: groth16Addr,
    deploymentTxs,
  };
}
