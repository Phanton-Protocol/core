import hre from "hardhat";

const { ethers } = hre;

const JOIN_SPLIT_FEE_LIB_FQN =
  "contracts/_full/libraries/JoinSplitFeeValidation.sol:JoinSplitFeeValidation";

/** Deploy the external join-split fee library (required to link Reduced / Upgradeable pool impls). */
export async function deployJoinSplitFeeValidationLib() {
  const Factory = await ethers.getContractFactory(JOIN_SPLIT_FEE_LIB_FQN);
  const lib = await Factory.deploy();
  await lib.waitForDeployment();
  return lib;
}

/** `getContractFactory` for ShieldedPoolUpgradeableReduced with JoinSplitFeeValidation linked. */
export async function getReducedPoolFactory(signer?: { address: string }) {
  const lib = await deployJoinSplitFeeValidationLib();
  const libraries = { JoinSplitFeeValidation: await lib.getAddress() };
  const factory = await ethers.getContractFactory("ShieldedPoolUpgradeableReduced", { libraries });
  return signer ? factory.connect(signer) : factory;
}
