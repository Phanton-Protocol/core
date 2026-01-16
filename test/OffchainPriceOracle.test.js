const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OffchainPriceOracle", function () {
  let oracle;
  let owner;
  let signer;
  let relayer;
  let other;

  const TOKEN = "0x0000000000000000000000000000000000000001";
  const PRICE = 123_456_789n; // 1.23456789 USD (1e8)

  beforeEach(async function () {
    [owner, signer, relayer, other] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("OffchainPriceOracle");
    oracle = await Oracle.deploy(await signer.getAddress());
  });

  async function signUpdate(update, signerWallet) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "OffchainPriceOracle",
      version: "1",
      chainId,
      verifyingContract: await oracle.getAddress(),
    };
    const types = {
      PriceUpdate: [
        { name: "token", type: "address" },
        { name: "price", type: "uint256" },
        { name: "timestamp", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };

    return signerWallet.signTypedData(domain, types, update);
  }

  it("updates price with valid signature", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const update = {
      token: TOKEN,
      price: PRICE.toString(),
      timestamp: now,
      nonce: 1,
    };

    const signature = await signUpdate(update, signer);
    await expect(oracle.connect(relayer).updatePrice(update, signature))
      .to.emit(oracle, "PriceUpdated");

    const [price, updatedAt] = await oracle.getPrice(TOKEN);
    expect(price).to.equal(PRICE);
    expect(updatedAt).to.equal(now);
  });

  it("rejects invalid signature", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const update = {
      token: TOKEN,
      price: PRICE.toString(),
      timestamp: now,
      nonce: 2,
    };

    const badSig = await signUpdate(update, other);
    await expect(oracle.connect(relayer).updatePrice(update, badSig))
      .to.be.revertedWith("OffchainPriceOracle: invalid signature");
  });

  it("rejects stale price", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const update = {
      token: TOKEN,
      price: PRICE.toString(),
      timestamp: now - 11 * 60,
      nonce: 3,
    };

    const signature = await signUpdate(update, signer);
    await expect(oracle.connect(relayer).updatePrice(update, signature))
      .to.be.revertedWith("OffchainPriceOracle: stale price");
  });

  it("rejects nonce reuse", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const update = {
      token: TOKEN,
      price: PRICE.toString(),
      timestamp: now,
      nonce: 4,
    };

    const signature = await signUpdate(update, signer);
    await oracle.connect(relayer).updatePrice(update, signature);

    await expect(oracle.connect(relayer).updatePrice(update, signature))
      .to.be.revertedWith("OffchainPriceOracle: nonce used");
  });
});
