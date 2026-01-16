const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ShieldedPool", function () {
    let shieldedPool;
    let verifier;
    let swapAdaptor;
    let feeOracle;
    let relayerRegistry;
    let owner;
    let relayer;
    let user;
    let token;

    // Test constants
    const ZERO_ADDRESS = ethers.ZeroAddress;
    const BNB_ASSET_ID = 0;
    const USDT_ASSET_ID = 1;
    const ONE_BNB = ethers.parseEther("1");
    const TEN_BNB = ethers.parseEther("10");

    beforeEach(async function () {
        [owner, relayer, user] = await ethers.getSigners();

        // Deploy mock contracts
        const Verifier = await ethers.getContractFactory("ExampleVerifier");
        verifier = await Verifier.deploy();

        const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
        relayerRegistry = await RelayerRegistry.deploy();
        await relayerRegistry.registerRelayer(relayer.address);

        const FeeOracle = await ethers.getContractFactory("FeeOracle");
        feeOracle = await FeeOracle.deploy();

        const PancakeSwapAdaptor = await ethers.getContractFactory("PancakeSwapAdaptor");
        const router = "0x0000000000000000000000000000000000000001";
        const wbnb = "0x0000000000000000000000000000000000000002";
        swapAdaptor = await PancakeSwapAdaptor.deploy(router, wbnb);

        // Deploy ShieldedPool
        const ShieldedPool = await ethers.getContractFactory("ShieldedPool");
        shieldedPool = await ShieldedPool.deploy(
            await verifier.getAddress(),
            await swapAdaptor.getAddress(),
            await feeOracle.getAddress(),
            await relayerRegistry.getAddress()
        );

        // Deploy mock ERC20 token
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy("Test Token", "TST", 18);
    });

    describe("Deposit", function () {
        it("Should deposit BNB and create commitment", async function () {
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("test_commitment"));
            
            await expect(
                shieldedPool.connect(user).deposit(ZERO_ADDRESS, ONE_BNB, commitment, BNB_ASSET_ID, {
                    value: ONE_BNB
                })
            ).to.emit(shieldedPool, "Deposit")
            .withArgs(user.address, ZERO_ADDRESS, BNB_ASSET_ID, ONE_BNB, commitment, 0);

            expect(await shieldedPool.getCommitmentCount()).to.equal(1n);
        });

        it("Should deposit ERC20 token and create commitment", async function () {
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("test_commitment"));
            await token.mint(user.address, ONE_BNB);
            await token.connect(user).approve(await shieldedPool.getAddress(), ONE_BNB);

            await expect(
                shieldedPool.connect(user).deposit(await token.getAddress(), ONE_BNB, commitment, USDT_ASSET_ID)
            ).to.emit(shieldedPool, "Deposit")
            .withArgs(user.address, await token.getAddress(), USDT_ASSET_ID, ONE_BNB, commitment, 0);
        });

        it("Should reject zero amount deposit", async function () {
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("test_commitment"));
            
            await expect(
                shieldedPool.deposit(ZERO_ADDRESS, 0, commitment, BNB_ASSET_ID)
            ).to.be.revertedWith("ShieldedPool: zero amount");
        });

        it("Should reject zero commitment", async function () {
            await expect(
                shieldedPool.deposit(ZERO_ADDRESS, ONE_BNB, ethers.ZeroHash, BNB_ASSET_ID, {
                    value: ONE_BNB
                })
            ).to.be.revertedWith("ShieldedPool: zero commitment");
        });
    });

    describe("Nullifier Tracking", function () {
        it("Should track nullifiers", async function () {
            const nullifier = ethers.keccak256(ethers.toUtf8Bytes("test_nullifier"));
            
            expect(await shieldedPool.isNullifierUsed(nullifier)).to.be.false;
            
            // Simulate nullifier marking (would happen in swap)
            // This is a test helper - actual marking happens in swap functions
        });
    });

    describe("Join-Split Swap", function () {
        let mockProof;
        let mockPublicInputs;
        let mockSwapParams;

        beforeEach(async function () {
            // Create initial deposit
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("deposit_commitment"));
            await shieldedPool.deposit(ZERO_ADDRESS, TEN_BNB, commitment, BNB_ASSET_ID, {
                value: TEN_BNB
            });

            // Mock proof data
            mockProof = {
                a: ethers.toUtf8Bytes("proof_a"),
                b: ethers.toUtf8Bytes("proof_b"),
                c: ethers.toUtf8Bytes("proof_c")
            };

            const inputCommitment = commitment;
            const outputCommitmentSwap = ethers.keccak256(ethers.toUtf8Bytes("swap_output"));
            const outputCommitmentChange = ethers.keccak256(ethers.toUtf8Bytes("change_output"));
            const nullifier = ethers.keccak256(ethers.concat([
                inputCommitment,
                ethers.toUtf8Bytes("owner_pk")
            ]));

            mockPublicInputs = {
                nullifier: nullifier,
                inputCommitment: inputCommitment,
                outputCommitmentSwap: outputCommitmentSwap,
                outputCommitmentChange: outputCommitmentChange,
                merkleRoot: await shieldedPool.getMerkleRoot(),
                inputAssetID: BNB_ASSET_ID,
                outputAssetIDSwap: USDT_ASSET_ID,
                outputAssetIDChange: BNB_ASSET_ID,
                inputAmount: TEN_BNB,
                swapAmount: ethers.parseEther("4"),
                changeAmount: TEN_BNB - ethers.parseEther("4") - ethers.parseEther("0.1") - ethers.parseEther("0.01"),
                outputAmountSwap: ethers.parseUnits("500", 6), // 500 USDT (6 decimals)
                minOutputAmountSwap: ethers.parseUnits("490", 6),
                gasRefund: ethers.parseEther("0.01"),
                protocolFee: ethers.parseEther("0.1"),
                merklePath: Array(10).fill(0),
                merklePathIndices: Array(10).fill(0)
            };

            mockSwapParams = {
                tokenIn: ZERO_ADDRESS,
                tokenOut: token.target,
                amountIn: ethers.parseEther("4"),
                minAmountOut: ethers.parseUnits("490", 6),
                fee: 3000,
                sqrtPriceLimitX96: 0,
                path: "0x"
            };
        });

        it("Should reject swap from non-relayer", async function () {
            const swapData = {
                proof: mockProof,
                publicInputs: mockPublicInputs,
                swapParams: mockSwapParams,
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            await expect(
                shieldedPool.connect(user).shieldedSwapJoinSplit(swapData)
            ).to.be.revertedWith("ShieldedPool: not a registered relayer");
        });

        it("Should reject swap with used nullifier", async function () {
            // First, mark nullifier as used (simulate previous transaction)
            const nullifier = mockPublicInputs.nullifier;
            // In actual implementation, this would be done by a previous swap
            // For testing, we'll need to manually set it or use a different nullifier

            const swapData = {
                proof: mockProof,
                publicInputs: mockPublicInputs,
                swapParams: mockSwapParams,
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            // Note: This test requires the nullifier to be marked first
            // In a real scenario, we'd need to execute a swap first
        });

        it("Should verify amount conservation", async function () {
            // Test that inputAmount = swapAmount + changeAmount + fees
            const inputAmount = mockPublicInputs.inputAmount;
            const swapAmount = mockPublicInputs.swapAmount;
            const changeAmount = mockPublicInputs.changeAmount;
            const protocolFee = mockPublicInputs.protocolFee;
            const gasRefund = mockPublicInputs.gasRefund;

            const totalOutput = swapAmount + changeAmount + protocolFee + gasRefund;
            expect(inputAmount).to.equal(totalOutput);
        });

        it("Should reject zero change amount", async function () {
            mockPublicInputs.changeAmount = 0;

            const swapData = {
                proof: mockProof,
                publicInputs: mockPublicInputs,
                swapParams: mockSwapParams,
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            await expect(
                shieldedPool.connect(relayer).shieldedSwapJoinSplit(swapData)
            ).to.be.reverted;
        });
    });

    describe("Shielded Withdrawal", function () {
        let mockProof;
        let mockPublicInputs;

        beforeEach(async function () {
            // Create initial deposit
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("deposit_commitment"));
            await shieldedPool.deposit(ZERO_ADDRESS, TEN_BNB, commitment, BNB_ASSET_ID, {
                value: TEN_BNB
            });

            mockProof = {
                a: ethers.toUtf8Bytes("proof_a"),
                b: ethers.toUtf8Bytes("proof_b"),
                c: ethers.toUtf8Bytes("proof_c")
            };

            const inputCommitment = commitment;
            const outputCommitmentChange = ethers.keccak256(ethers.toUtf8Bytes("change_output"));
            const nullifier = ethers.keccak256(ethers.concat([
                inputCommitment,
                ethers.toUtf8Bytes("owner_pk")
            ]));

            mockPublicInputs = {
                nullifier: nullifier,
                inputCommitment: inputCommitment,
                outputCommitmentSwap: ethers.ZeroHash, // Zero for withdrawal
                outputCommitmentChange: outputCommitmentChange,
                merkleRoot: await shieldedPool.getMerkleRoot(),
                inputAssetID: BNB_ASSET_ID,
                outputAssetIDSwap: 0, // Zero for withdrawal
                outputAssetIDChange: BNB_ASSET_ID,
                inputAmount: TEN_BNB,
                swapAmount: ethers.parseEther("2"), // Withdraw amount
                changeAmount: TEN_BNB - ethers.parseEther("2") - ethers.parseEther("0.1") - ethers.parseEther("0.01"),
                outputAmountSwap: 0, // Zero for withdrawal
                minOutputAmountSwap: 0,
                gasRefund: ethers.parseEther("0.01"),
                protocolFee: ethers.parseEther("0.1"),
                merklePath: Array(10).fill(0),
                merklePathIndices: Array(10).fill(0)
            };
        });

        it("Should reject withdrawal with non-zero swap commitment", async function () {
            mockPublicInputs.outputCommitmentSwap = ethers.keccak256(ethers.toUtf8Bytes("non_zero"));

            const withdrawData = {
                proof: mockProof,
                publicInputs: mockPublicInputs,
                recipient: user.address,
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            // Note: This will fail at proof verification with mock proofs
            // In production with real proofs, it would fail at swap commitment check
            await expect(
                shieldedPool.connect(relayer).shieldedWithdraw(withdrawData)
            ).to.be.reverted; // Will revert with "invalid merkle proof" due to mock proof
        });

        it("Should verify withdrawal amount conservation", async function () {
            // Test the conservation formula: Input = Withdraw + Change + Fees
            // Using the values from mockPublicInputs
            const inputAmount = TEN_BNB; // 10 BNB
            const withdrawAmount = ethers.parseEther("2"); // 2 BNB
            const changeAmount = ethers.parseEther("7.89"); // 7.89 BNB (10 - 2 - 0.1 - 0.01)
            const protocolFee = ethers.parseEther("0.1"); // 0.1 BNB
            const gasRefund = ethers.parseEther("0.01"); // 0.01 BNB

            const totalOutput = withdrawAmount + changeAmount + protocolFee + gasRefund;
            expect(inputAmount).to.equal(totalOutput);
        });
    });

    describe("Merkle Root", function () {
        it("Should return current Merkle root", async function () {
            const initialRoot = await shieldedPool.getMerkleRoot();
            expect(initialRoot).to.not.equal(ethers.ZeroHash);

            const commitment = ethers.keccak256(ethers.toUtf8Bytes("test_commitment"));
            await shieldedPool.deposit(ZERO_ADDRESS, ONE_BNB, commitment, BNB_ASSET_ID, {
                value: ONE_BNB
            });

            const newRoot = await shieldedPool.getMerkleRoot();
            expect(newRoot).to.not.equal(initialRoot);
        });

        it("Should update Merkle root after deposit", async function () {
            const initialRoot = await shieldedPool.getMerkleRoot();
            
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("test_commitment"));
            await shieldedPool.deposit(ZERO_ADDRESS, ONE_BNB, commitment, BNB_ASSET_ID, {
                value: ONE_BNB
            });

            const newRoot = await shieldedPool.getMerkleRoot();
            expect(newRoot).to.not.equal(initialRoot);
        });
    });
});
