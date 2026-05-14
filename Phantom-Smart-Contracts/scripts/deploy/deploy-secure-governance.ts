/* eslint-disable no-console */
/**
 * Module 1 audit fix — secure deployment of the OZ-backed Timelock +
 * Governance + (optionally) UUPS proxy initialization.
 *
 * Pipeline:
 *   1. Deploy ProtocolToken (or reuse PROTOCOL_TOKEN_ADDRESS)
 *   2. Deploy OZ TimelockController with:
 *        - minDelay        = TIMELOCK_DELAY_SECONDS (default 48h on prod)
 *        - proposers       = [tempProposer]  (the deployer; rotated to Gov below)
 *        - executors       = [address(0)]    (open execution post-delay)
 *        - admin           = deployer (revoked at the end)
 *   3. Deploy Governance pointing at (timelock, token, guardianMultisig)
 *   4. Grant Governance the PROPOSER_ROLE + CANCELLER_ROLE on the timelock
 *   5. Revoke deployer's PROPOSER_ROLE
 *   6. Optionally grant guardianMultisig the CANCELLER_ROLE
 *   7. Renounce deployer's TIMELOCK_ADMIN_ROLE (timelock self-administers)
 *   8. Print summary
 *
 * Env:
 *   PROTOCOL_TOKEN_ADDRESS         (optional; if unset, deploys new ProtocolToken)
 *   TIMELOCK_DELAY_SECONDS         (default: 172800 = 48h)
 *   GUARDIAN_MULTISIG              (optional CANCELLER_ROLE holder)
 *   GOVERNANCE_VOTING_PERIOD_BLOCKS (default: 50400 ≈ 7d)
 *   GOVERNANCE_QUORUM              (default: 1e18)
 *   GOVERNANCE_MIN_PROPOSAL_THRESHOLD (default: 100_000e18)
 *   ALLOW_LOW_DELAY                ("1" to bypass 48h floor on local/test)
 */
import { ethers, network } from "hardhat";

const FORTY_EIGHT_HOURS = 48n * 60n * 60n;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[deploy-secure-governance] network=${network.name} deployer=${deployer.address}`);

  const delaySeconds = BigInt(process.env.TIMELOCK_DELAY_SECONDS ?? FORTY_EIGHT_HOURS.toString());
  const allowLowDelay = process.env.ALLOW_LOW_DELAY === "1";
  if (delaySeconds < FORTY_EIGHT_HOURS && !allowLowDelay) {
    throw new Error(
      `Refusing to deploy timelock with delay ${delaySeconds}s < 48h. ` +
      `Set ALLOW_LOW_DELAY=1 explicitly for dev/test networks.`
    );
  }

  // 1. ProtocolToken
  const TokenAddr = process.env.PROTOCOL_TOKEN_ADDRESS;
  let tokenAddress: string;
  if (TokenAddr && TokenAddr !== ethers.ZeroAddress) {
    tokenAddress = TokenAddr;
    console.log(`Using existing ProtocolToken ${tokenAddress}`);
  } else {
    const ProtocolToken = await ethers.getContractFactory("ProtocolToken");
    const token = await ProtocolToken.deploy(deployer.address);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    console.log(`ProtocolToken deployed at ${tokenAddress}`);
  }

  // 2. TimelockController (proposers = [deployer] temporarily; rotated below)
  const TLC = await ethers.getContractFactory(
    "contracts/_full/governance/TimelockController.sol:TimelockController"
  );
  const tlc = await TLC.deploy(delaySeconds, [deployer.address], [ethers.ZeroAddress], deployer.address);
  await tlc.waitForDeployment();
  const timelockAddress = await tlc.getAddress();
  console.log(`TimelockController deployed at ${timelockAddress} (delay=${delaySeconds}s)`);

  // 3. Governance
  const Gov = await ethers.getContractFactory(
    "contracts/_full/governance/Governance.sol:Governance"
  );
  const guardian = process.env.GUARDIAN_MULTISIG && process.env.GUARDIAN_MULTISIG !== ethers.ZeroAddress
    ? process.env.GUARDIAN_MULTISIG
    : deployer.address;
  const votingPeriod = BigInt(process.env.GOVERNANCE_VOTING_PERIOD_BLOCKS ?? 50400);
  const quorum = BigInt(process.env.GOVERNANCE_QUORUM ?? ethers.parseEther("1").toString());
  const minThreshold = BigInt(
    process.env.GOVERNANCE_MIN_PROPOSAL_THRESHOLD ?? ethers.parseEther("100000").toString()
  );

  const gov = await Gov.deploy(
    timelockAddress,
    tokenAddress,
    guardian,
    votingPeriod,
    quorum,
    minThreshold
  );
  await gov.waitForDeployment();
  const governanceAddress = await gov.getAddress();
  console.log(`Governance deployed at ${governanceAddress} (guardian=${guardian})`);

  // 4-7. Role wiring
  const PROPOSER_ROLE = await tlc.PROPOSER_ROLE();
  const CANCELLER_ROLE = await tlc.CANCELLER_ROLE();
  const ADMIN_ROLE = await tlc.TIMELOCK_ADMIN_ROLE();

  console.log("Granting PROPOSER_ROLE + CANCELLER_ROLE to Governance ...");
  await (await tlc.grantRole(PROPOSER_ROLE, governanceAddress)).wait();
  await (await tlc.grantRole(CANCELLER_ROLE, governanceAddress)).wait();

  if (guardian !== deployer.address) {
    console.log(`Granting CANCELLER_ROLE to guardian ${guardian} ...`);
    await (await tlc.grantRole(CANCELLER_ROLE, guardian)).wait();
  }

  console.log("Revoking deployer PROPOSER_ROLE (bootstrap-only) ...");
  await (await tlc.revokeRole(PROPOSER_ROLE, deployer.address)).wait();

  console.log("Renouncing deployer TIMELOCK_ADMIN_ROLE (timelock self-administers) ...");
  await (await tlc.renounceRole(ADMIN_ROLE, deployer.address)).wait();

  console.log("\n=========== Deployment Summary ===========");
  console.log(JSON.stringify({
    network: network.name,
    protocolToken: tokenAddress,
    timelock: timelockAddress,
    governance: governanceAddress,
    guardian,
    delaySeconds: delaySeconds.toString(),
    votingPeriodBlocks: votingPeriod.toString(),
    quorum: quorum.toString(),
    minProposalThreshold: minThreshold.toString(),
  }, null, 2));
  console.log("==========================================\n");

  console.log("NEXT STEPS:");
  console.log("  - Call ShieldedPoolUpgradeable.transferOwnership(timelock)");
  console.log("  - For ShieldedPoolUpgradeableReduced proxies, call initializeV2(timelock, emergencyAdmin)");
  console.log("  - Verify no EOA holds PROPOSER_ROLE or DEFAULT_ADMIN_ROLE on the timelock.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
