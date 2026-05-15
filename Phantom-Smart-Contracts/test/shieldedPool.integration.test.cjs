const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  merkleProofForFirstLeaf,
  emptyProof,
  deployPoolFixture,
  totalJoinSplitFeeBnb,
  withdrawProtocolFee,
  commitJoinSplitMevProtection,
} = require("./helpers/poolFixtures.cjs");
const {
  attachJoinSplitRelayerAttestation,
} = require("./helpers/relayerSwapAttestation.cjs");
const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

describe("ShieldedPool — deposit / swap / withdraw (integration)", function () {
  describe("deposit", function () {
    it("accepts two native deposits and increments commitmentCount", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const a = ethers.parseEther("1");
      const c1 = ethers.keccak256(ethers.toUtf8Bytes("c1"));
      const c2 = ethers.keccak256(ethers.toUtf8Bytes("c2"));

      await pool.connect(deployer).deposit(ethers.ZeroAddress, a, c1, 0n, { value: a });
      expect(await pool.commitmentCount()).to.equal(1n);

      await pool.connect(deployer).deposit(ethers.ZeroAddress, a, c2, 0n, { value: a });
      expect(await pool.commitmentCount()).to.equal(2n);
    });

    it("reverts deposit with zero commitment (PoolErr 27)", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const a = ethers.parseEther("1");
      await expect(
        pool.connect(deployer).deposit(ethers.ZeroAddress, a, ethers.ZeroHash, 0n, { value: a })
      )
        .to.be.revertedWithCustomError(pool, "PoolErr")
        .withArgs(27);
    });

    it("owner registers MockERC20 on assetRegistry (used by swap output path)", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const token = await MockERC20.deploy("T", "T", 18);
      await token.waitForDeployment();
      const tAddr = await token.getAddress();
      await pool.connect(deployer).registerAsset(1n, tAddr);
      expect(await pool.assetRegistry(1n)).to.equal(tAddr);
    });

    it("ERC20 deposit: transferFrom pulls tokens to pool + commitment + Deposit event", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const token = await MockERC20.deploy("T2", "T2", 18);
      await token.waitForDeployment();
      const tAddr = await token.getAddress();
      await pool.connect(deployer).registerAsset(1n, tAddr);

      const amt = ethers.parseEther("7");
      await token.mint(deployer.address, amt);
      await token.connect(deployer).approve(await pool.getAddress(), amt);

      const c = ethers.keccak256(ethers.toUtf8Bytes("erc20-dep-module1"));
      const poolAddr = await pool.getAddress();
      await expect(pool.connect(deployer).deposit(tAddr, amt, c, 1n, { value: 1n })).to.emit(pool, "Deposit");

      expect(await token.balanceOf(poolAddr)).to.equal(amt);
      expect(await pool.commitmentCount()).to.equal(1n);
    });
  });

  describe("shieldedSwapJoinSplit (BNB → ERC20)", function () {
    it("spends note, runs mock swap, inserts swap + change commitments", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();

      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("Out", "O", 18);
      await outTok.waitForDeployment();
      const outAddr = await outTok.getAddress();
      await pool.connect(deployer).registerAsset(1n, outAddr);

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("note-for-swap"));
      const inputAmount = ethers.parseEther("25");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      expect(await pool.merkleRoot()).to.equal(root);

      const swapAmount = ethers.parseEther("5");
      const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
      const gasRefund = 0n;
      const changeAmount = inputAmount - swapAmount - totalPf - gasRefund;

      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("null-swap-1"));
      const outSwap = ethers.keccak256(ethers.toUtf8Bytes("out-swap"));
      const outChange = ethers.keccak256(ethers.toUtf8Bytes("out-change"));

      const publicInputs = {
        nullifier,
        inputCommitment: commitment,
        outputCommitmentSwap: outSwap,
        outputCommitmentChange: outChange,
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount,
        changeAmount,
        outputAmountSwap: swapAmount,
        minOutputAmountSwap: swapAmount,
        gasRefund,
        protocolFee: totalPf,
        merklePath: path,
        merklePathIndices: indices,
      };

      const mev = await commitJoinSplitMevProtection(pool, deployer, "int-swap-1");

      const swapData = await attachJoinSplitRelayerAttestation(deployer, pool, {
        proof: emptyProof(),
        publicInputs,
        swapParams: {
          tokenIn: ethers.ZeroAddress,
          tokenOut: outAddr,
          amountIn: swapAmount,
          minAmountOut: swapAmount,
          fee: 0,
          sqrtPriceLimitX96: 0n,
          path: "0x",
        },
        relayer: ethers.ZeroAddress,
        commitment: mev.commitment,
        deadline: mev.deadline,
        nonce: mev.nonce,
        encryptedPayload: "0x",
      });

      const rootBefore = await pool.merkleRoot();
      await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.emit(
        pool,
        "ShieldedSwapJoinSplit"
      );
      expect(await pool.merkleRoot()).to.not.equal(rootBefore);
      expect(await pool.nullifiers(nullifier)).to.equal(true);
      expect(await pool.commitmentCount()).to.equal(3n);
    });

    it("reverts when merkleRoot does not match pool (PoolErr 41)", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();

      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("Out", "O", 18);
      await outTok.waitForDeployment();
      await pool.connect(deployer).registerAsset(1n, await outTok.getAddress());

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("bad-root"));
      const inputAmount = ethers.parseEther("25");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
      const swapAmount = ethers.parseEther("5");
      const changeAmount = inputAmount - swapAmount - totalPf;

      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("n2")),
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("os")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("oc")),
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes("wrong-root")),
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount,
        changeAmount,
        outputAmountSwap: swapAmount,
        minOutputAmountSwap: swapAmount,
        gasRefund: 0n,
        protocolFee: totalPf,
        merklePath: path,
        merklePathIndices: indices,
      };

      const mev = await commitJoinSplitMevProtection(pool, deployer, "int-bad-root");

      const swapData = await attachJoinSplitRelayerAttestation(deployer, pool, {
        proof: emptyProof(),
        publicInputs,
        swapParams: {
          tokenIn: ethers.ZeroAddress,
          tokenOut: await outTok.getAddress(),
          amountIn: swapAmount,
          minAmountOut: swapAmount,
          fee: 0,
          sqrtPriceLimitX96: 0n,
          path: "0x",
        },
        relayer: ethers.ZeroAddress,
        commitment: mev.commitment,
        deadline: mev.deadline,
        nonce: mev.nonce,
        encryptedPayload: "0x",
      });

      await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData))
        .to.be.revertedWithCustomError(pool, "PoolErr")
        .withArgs(41);
    });

    it("reverts when merkle path does not prove inputCommitment (PoolErr 42)", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();

      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("Out", "O", 18);
      await outTok.waitForDeployment();
      await pool.connect(deployer).registerAsset(1n, await outTok.getAddress());

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("bad-path"));
      const inputAmount = ethers.parseEther("25");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
      const swapAmount = ethers.parseEther("5");
      const changeAmount = inputAmount - swapAmount - totalPf;

      const badPath = [...path];
      badPath[0] = badPath[0] + 1n;

      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("np")),
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("os2")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("oc2")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount,
        changeAmount,
        outputAmountSwap: swapAmount,
        minOutputAmountSwap: swapAmount,
        gasRefund: 0n,
        protocolFee: totalPf,
        merklePath: badPath,
        merklePathIndices: indices,
      };

      const mev = await commitJoinSplitMevProtection(pool, deployer, "int-bad-path");

      const swapData = await attachJoinSplitRelayerAttestation(deployer, pool, {
        proof: emptyProof(),
        publicInputs,
        swapParams: {
          tokenIn: ethers.ZeroAddress,
          tokenOut: await outTok.getAddress(),
          amountIn: swapAmount,
          minAmountOut: swapAmount,
          fee: 0,
          sqrtPriceLimitX96: 0n,
          path: "0x",
        },
        relayer: ethers.ZeroAddress,
        commitment: mev.commitment,
        deadline: mev.deadline,
        nonce: mev.nonce,
        encryptedPayload: "0x",
      });

      await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData))
        .to.be.revertedWithCustomError(pool, "PoolErr")
        .withArgs(42);
    });
  });

  describe("shieldedWithdraw (native BNB)", function () {
    it("pays recipient, inserts change, marks nullifier", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const [, recipient] = await ethers.getSigners();

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("note-withdraw"));
      const inputAmount = ethers.parseEther("3");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);

      const withdrawAmount = ethers.parseEther("0.5");
      const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount);
      const gasRefund = 0n;
      const changeAmount = inputAmount - withdrawAmount - protocolFee - gasRefund;

      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("null-wd-1"));
      const outChange = ethers.keccak256(ethers.toUtf8Bytes("change-wd"));

      const publicInputs = {
        nullifier,
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.ZeroHash,
        outputCommitmentChange: outChange,
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 0n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: withdrawAmount,
        changeAmount,
        outputAmountSwap: 0n,
        minOutputAmountSwap: 0n,
        gasRefund,
        protocolFee,
        merklePath: path,
        merklePathIndices: indices,
      };

      const withdrawData = {
        proof: emptyProof(),
        publicInputs,
        recipient: recipient.address,
        relayer: ethers.ZeroAddress,
        encryptedPayload: "0x",
      };

      const balBefore = await ethers.provider.getBalance(recipient.address);
      await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.emit(pool, "ShieldedWithdraw");
      const balAfter = await ethers.provider.getBalance(recipient.address);
      expect(balAfter - balBefore).to.equal(withdrawAmount);
      expect(await pool.nullifiers(nullifier)).to.equal(true);
      expect(await pool.commitmentCount()).to.equal(2n);
    });

    it("reverts when nullifier already used (PoolErr 4)", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const [, recipient] = await ethers.getSigners();

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("note-dbl"));
      const inputAmount = ethers.parseEther("3");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const withdrawAmount = ethers.parseEther("0.5");
      const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount);
      const changeAmount = inputAmount - withdrawAmount - protocolFee;
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("same-null"));

      const mkWithdraw = () => ({
        proof: emptyProof(),
        publicInputs: {
          nullifier,
          inputCommitment: commitment,
          outputCommitmentSwap: ethers.ZeroHash,
          outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("ch1")),
          merkleRoot: root,
          inputAssetID: 0n,
          outputAssetIDSwap: 0n,
          outputAssetIDChange: 0n,
          inputAmount,
          swapAmount: withdrawAmount,
          changeAmount,
          outputAmountSwap: 0n,
          minOutputAmountSwap: 0n,
          gasRefund: 0n,
          protocolFee,
          merklePath: path,
          merklePathIndices: indices,
        },
        recipient: recipient.address,
        relayer: ethers.ZeroAddress,
        encryptedPayload: "0x",
      });

      await pool.connect(deployer).shieldedWithdraw(mkWithdraw());

      await expect(pool.connect(deployer).shieldedWithdraw(mkWithdraw()))
        .to.be.revertedWithCustomError(pool, "PoolErr")
        .withArgs(4);
    });

    it("reverts when conservation breaks (PoolErr 43)", async function () {
      const { deployer, pool, feeOracle } = await deployPoolFixture();
      const [, recipient] = await ethers.getSigners();

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("note-bad-cons"));
      const inputAmount = ethers.parseEther("2");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount);

      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("nbc")),
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.ZeroHash,
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("x")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 0n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: ethers.parseEther("1"),
        changeAmount: ethers.parseEther("1"),
        outputAmountSwap: 0n,
        minOutputAmountSwap: 0n,
        gasRefund: 0n,
        protocolFee,
        merklePath: path,
        merklePathIndices: indices,
      };

      await expect(
        pool.connect(deployer).shieldedWithdraw({
          proof: emptyProof(),
          publicInputs,
          recipient: recipient.address,
          relayer: ethers.ZeroAddress,
          encryptedPayload: "0x",
        })
      )
        .to.be.revertedWithCustomError(pool, "PoolErr")
        .withArgs(43);
    });
  });
});
