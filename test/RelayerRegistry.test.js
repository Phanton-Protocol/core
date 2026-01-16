const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RelayerRegistry", function () {
    let relayerRegistry;
    let owner;
    let relayer1;
    let relayer2;
    let nonRelayer;

    beforeEach(async function () {
        [owner, relayer1, relayer2, nonRelayer] = await ethers.getSigners();

        const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
        relayerRegistry = await RelayerRegistry.deploy();
    });

    describe("Registration", function () {
        it("Should register a new relayer", async function () {
            await expect(relayerRegistry.registerRelayer(relayer1.address))
                .to.emit(relayerRegistry, "RelayerRegistered")
                .withArgs(relayer1.address);

            expect(await relayerRegistry.isRelayer(relayer1.address)).to.be.true;
        });

        it("Should reject registration from non-owner", async function () {
            await expect(
                relayerRegistry.connect(relayer1).registerRelayer(relayer2.address)
            ).to.be.revertedWith("RelayerRegistry: not owner");
        });

        it("Should reject zero address registration", async function () {
            await expect(
                relayerRegistry.registerRelayer(ethers.ZeroAddress)
            ).to.be.revertedWith("RelayerRegistry: zero address");
        });

        it("Should reject duplicate registration", async function () {
            await relayerRegistry.registerRelayer(relayer1.address);
            
            await expect(
                relayerRegistry.registerRelayer(relayer1.address)
            ).to.be.revertedWith("RelayerRegistry: already registered");
        });
    });

    describe("Removal", function () {
        beforeEach(async function () {
            await relayerRegistry.registerRelayer(relayer1.address);
            await relayerRegistry.registerRelayer(relayer2.address);
        });

        it("Should remove a relayer", async function () {
            await expect(relayerRegistry.removeRelayer(relayer1.address))
                .to.emit(relayerRegistry, "RelayerRemoved")
                .withArgs(relayer1.address);

            expect(await relayerRegistry.isRelayer(relayer1.address)).to.be.false;
            expect(await relayerRegistry.isRelayer(relayer2.address)).to.be.true;
        });

        it("Should reject removal from non-owner", async function () {
            await expect(
                relayerRegistry.connect(relayer1).removeRelayer(relayer2.address)
            ).to.be.revertedWith("RelayerRegistry: not owner");
        });

        it("Should reject removal of non-registered relayer", async function () {
            await expect(
                relayerRegistry.removeRelayer(nonRelayer.address)
            ).to.be.revertedWith("RelayerRegistry: not registered");
        });
    });

    describe("Ownership", function () {
        it("Should transfer ownership", async function () {
            await expect(relayerRegistry.transferOwnership(relayer1.address))
                .to.emit(relayerRegistry, "OwnershipTransferred")
                .withArgs(owner.address, relayer1.address);

            // New owner can register relayers
            await expect(
                relayerRegistry.connect(relayer1).registerRelayer(relayer2.address)
            ).to.emit(relayerRegistry, "RelayerRegistered");
        });

        it("Should reject zero address ownership transfer", async function () {
            await expect(
                relayerRegistry.transferOwnership(ethers.ZeroAddress)
            ).to.be.revertedWith("RelayerRegistry: zero address");
        });
    });
});
