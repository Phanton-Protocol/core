import hre from "hardhat";

const { ethers } = hre;

async function main() {
  const recipient = String(process.env.MINT_RECIPIENT || "").trim();
  if (!recipient || !ethers.isAddress(recipient)) throw new Error("MINT_RECIPIENT required");

  const MockERC20 = await ethers.getContractFactory("contracts/_full/mocks/MockERC20.sol:MockERC20");
  const token = await MockERC20.deploy("Phantom Mock USDT", "USDT", 18);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const mintAmount = ethers.parseUnits(String(process.env.MINT_AMOUNT || "1000000"), 18);
  await (await token.mint(recipient, mintAmount)).wait();

  console.log("mockUsdt:", tokenAddr);
  console.log("mintRecipient:", recipient);
  console.log("mintAmount:", mintAmount.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
