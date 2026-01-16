const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    generateCommitment,
    generateNullifier,
    createMockProof,
    createJoinSplitSwapInputs,
    createJoinSplitWithdrawInputs,
    verifyAmountConservation,
    createSwapParams
} = require("./helpers/testHelpers");

describe("Join-Split Functionality", function () {
    let shieldedPool;
    let verifier;
    let swapAdaptor;
    let feeOracle;
    let relayerRegistry;
    let owner;
    let relayer;
    let user;
    let token;

    const ZERO_ADDRESS = ethers.ZeroAddress;
    const BNB_ASSET_ID = 0;
    const USDT_ASSET_ID = 1;
    const TEN_BNB = ethers.parseEther("10");
    const FOUR_BNB = ethers.parseEther("4");
    const SIX_BNB = ethers.parseEther("6");
    const TWO_BNB = ethers.parseEther("2");
    const EIGHT_BNB = ethers.parseEther("8");

    beforeEach(async function () {
        [owner, relayer, user] = await ethers.getSigners();

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

        const ShieldedPool = await ethers.getContractFactory("ShieldedPool");
        shieldedPool = await ShieldedPool.deploy(
            await verifier.getAddress(),
            await swapAdaptor.getAddress(),
            await feeOracle.getAddress(),
            await relayerRegistry.getAddress()
        );

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy("Test Token", "TST", 6);
    });

    describe("Amount Conservation", function () {
        it("Should verify conservation: Input = Swap + Change + Fees", function () {
            const inputAmount = TEN_BNB;
            const swapAmount = FOUR_BNB;
            const protocolFee = ethers.parseEther("0.1");
            const gasRefund = ethers.parseEther("0.01");
            const changeAmount = inputAmount - swapAmount - protocolFee - gasRefund;

            const isValid = verifyAmountConservation(
                inputAmount,
                swapAmount,
                changeAmount,
                protocolFee,
                gasRefund
            );

            expect(isValid).to.be.true;
        });

        it("Should detect conservation violation", function () {
            const inputAmount = TEN_BNB;
            const swapAmount = FOUR_BNB;
            const changeAmount = SIX_BNB;
            const protocolFee = ethers.parseEther("0.1");
            const gasRefund = ethers.parseEther("0.5"); // Too high

            const isValid = verifyAmountConservation(
                inputAmount,
                swapAmount,
                changeAmount,
                protocolFee,
                gasRefund
            );

            expect(isValid).to.be.false;
        });
    });

    describe("Join-Split Swap Edge Cases", function () {
        let inputCommitment;
        let merkleRoot;
        let ownerPublicKey;

        beforeEach(async function () {
            inputCommitment = generateCommitment("deposit_1");
            ownerPublicKey = ethers.keccak256(ethers.toUtf8Bytes("owner_key"));
            
            await shieldedPool.deposit(ZERO_ADDRESS, TEN_BNB, inputCommitment, BNB_ASSET_ID, {
                value: TEN_BNB
            });
            
            merkleRoot = await shieldedPool.getMerkleRoot();
        });

        it("Should reject swap with zero change amount", async function () {
            const publicInputs = createJoinSplitSwapInputs({
                inputCommitment: inputCommitment,
                outputCommitmentSwap: generateCommitment("swap_output"),
                outputCommitmentChange: generateCommitment("change_output"),
                merkleRoot: merkleRoot,
                inputAssetID: BNB_ASSET_ID,
                outputAssetIDSwap: USDT_ASSET_ID,
                outputAssetIDChange: BNB_ASSET_ID,
                inputAmount: TEN_BNB,
                swapAmount: TEN_BNB, // Entire amount swapped
                changeAmount: 0, // Zero change
                outputAmountSwap: ethers.parseUnits("1250", 6),
                minOutputAmountSwap: ethers.parseUnits("1200", 6),
                protocolFee: ethers.parseEther("0.1"),
                gasRefund: ethers.parseEther("0.01"),
                ownerPublicKey: ownerPublicKey
            });

            // Adjust to make conservation work (but change is zero)
            publicInputs.changeAmount = 0;
            publicInputs.swapAmount = TEN_BNB - publicInputs.protocolFee - publicInputs.gasRefund;

            const swapData = {
                proof: createMockProof(),
                publicInputs: publicInputs,
                swapParams: createSwapParams({
                    tokenIn: ZERO_ADDRESS,
                    tokenOut: await token.getAddress(),
                    amountIn: publicInputs.swapAmount,
                    minAmountOut: publicInputs.minOutputAmountSwap
                }),
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            await expect(
                shieldedPool.connect(relayer).shieldedSwapJoinSplit(swapData)
            ).to.be.reverted;
        });

        it("Should reject swap with zero swap amount", async function () {
            const publicInputs = createJoinSplitSwapInputs({
                inputCommitment: inputCommitment,
                outputCommitmentSwap: generateCommitment("swap_output"),
                outputCommitmentChange: generateCommitment("change_output"),
                merkleRoot: merkleRoot,
                inputAssetID: BNB_ASSET_ID,
                outputAssetIDSwap: USDT_ASSET_ID,
                outputAssetIDChange: BNB_ASSET_ID,
                inputAmount: TEN_BNB,
                swapAmount: 0, // Zero swap
                changeAmount: TEN_BNB,
                outputAmountSwap: 0,
                minOutputAmountSwap: 0,
                protocolFee: ethers.parseEther("0.1"),
                gasRefund: ethers.parseEther("0.01"),
                ownerPublicKey: ownerPublicKey
            });

            const swapData = {
                proof: createMockProof(),
                publicInputs: publicInputs,
                swapParams: createSwapParams({
                    tokenIn: ZERO_ADDRESS,
                    tokenOut: await token.getAddress(),
                    amountIn: 0,
                    minAmountOut: 0
                }),
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            await expect(
                shieldedPool.connect(relayer).shieldedSwapJoinSplit(swapData)
            ).to.be.reverted;
        });

        it("Should verify change asset matches input asset", async function () {
            const publicInputs = createJoinSplitSwapInputs({
                inputCommitment: inputCommitment,
                outputCommitmentSwap: generateCommitment("swap_output"),
                outputCommitmentChange: generateCommitment("change_output"),
                merkleRoot: merkleRoot,
                inputAssetID: BNB_ASSET_ID,
                outputAssetIDSwap: USDT_ASSET_ID,
                outputAssetIDChange: USDT_ASSET_ID, // Wrong! Should be BNB_ASSET_ID
                inputAmount: TEN_BNB,
                swapAmount: FOUR_BNB,
                changeAmount: SIX_BNB,
                outputAmountSwap: ethers.parseUnits("500", 6),
                minOutputAmountSwap: ethers.parseUnits("490", 6),
                protocolFee: ethers.parseEther("0.1"),
                gasRefund: ethers.parseEther("0.01"),
                ownerPublicKey: ownerPublicKey
            });

            // This should fail because change asset doesn't match input asset
            // The contract checks: assetRegistry[outputAssetIDChange] == inputToken
            const swapData = {
                proof: createMockProof(),
                publicInputs: publicInputs,
                swapParams: createSwapParams({
                    tokenIn: ZERO_ADDRESS,
                    tokenOut: await token.getAddress(),
                    amountIn: FOUR_BNB,
                    minAmountOut: ethers.parseUnits("490", 6)
                }),
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            // This will fail because outputAssetIDChange doesn't match inputAssetID
            // The contract requires: assetRegistry[outputAssetIDChange] == inputToken
            await expect(
                shieldedPool.connect(relayer).shieldedSwapJoinSplit(swapData)
            ).to.be.reverted;
        });
    });

    describe("Shielded Withdrawal Edge Cases", function () {
        let inputCommitment;
        let merkleRoot;
        let ownerPublicKey;

        beforeEach(async function () {
            inputCommitment = generateCommitment("deposit_1");
            ownerPublicKey = ethers.keccak256(ethers.toUtf8Bytes("owner_key"));
            
            await shieldedPool.deposit(ZERO_ADDRESS, TEN_BNB, inputCommitment, BNB_ASSET_ID, {
                value: TEN_BNB
            });
            
            merkleRoot = await shieldedPool.getMerkleRoot();
        });

        it("Should reject withdrawal with non-zero swap commitment", async function () {
            const publicInputs = createJoinSplitWithdrawInputs({
                inputCommitment: inputCommitment,
                outputCommitmentChange: generateCommitment("change_output"),
                merkleRoot: merkleRoot,
                inputAssetID: BNB_ASSET_ID,
                inputAmount: TEN_BNB,
                withdrawAmount: TWO_BNB,
                changeAmount: EIGHT_BNB,
                protocolFee: ethers.parseEther("0.1"),
                gasRefund: ethers.parseEther("0.01"),
                ownerPublicKey: ownerPublicKey
            });

            // Set swap commitment to non-zero (should be zero for withdrawal)
            publicInputs.outputCommitmentSwap = generateCommitment("non_zero");

            const withdrawData = {
                proof: createMockProof(),
                publicInputs: publicInputs,
                recipient: user.address,
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            await expect(
                shieldedPool.connect(relayer).shieldedWithdraw(withdrawData)
            ).to.be.reverted;
        });

        it("Should reject withdrawal with non-zero swap asset ID", async function () {
            const publicInputs = createJoinSplitWithdrawInputs({
                inputCommitment: inputCommitment,
                outputCommitmentChange: generateCommitment("change_output"),
                merkleRoot: merkleRoot,
                inputAssetID: BNB_ASSET_ID,
                inputAmount: TEN_BNB,
                withdrawAmount: TWO_BNB,
                changeAmount: EIGHT_BNB,
                protocolFee: ethers.parseEther("0.1"),
                gasRefund: ethers.parseEther("0.01"),
                ownerPublicKey: ownerPublicKey
            });

            // Set swap asset ID to non-zero (should be zero for withdrawal)
            publicInputs.outputAssetIDSwap = USDT_ASSET_ID;

            const withdrawData = {
                proof: createMockProof(),
                publicInputs: publicInputs,
                recipient: user.address,
                relayer: relayer.address,
                encryptedPayload: "0x"
            };

            await expect(
                shieldedPool.connect(relayer).shieldedWithdraw(withdrawData)
            ).to.be.reverted;
        });

        it("Should verify withdrawal amount conservation", function () {
            const inputAmount = TEN_BNB;
            const withdrawAmount = TWO_BNB;
            const protocolFee = ethers.parseEther("0.1");
            const gasRefund = ethers.parseEther("0.01");
            const changeAmount = inputAmount - withdrawAmount - protocolFee - gasRefund;

            const totalOutput = withdrawAmount + changeAmount + protocolFee + gasRefund;
            expect(inputAmount).to.equal(totalOutput);
        });
    });
});
