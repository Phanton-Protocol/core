// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOffchainPriceOracle.sol";
import "../libraries/IntegrationMutability.sol";

/**
 * @title OffchainPriceOracle
 * @notice Accepts threshold-signed price updates from authorized signers (min 2-of-N).
 * @dev Price is USD with 8 decimals. Signature uses EIP-712. Signer roster changes require
 *      timelock once {initializeTimelock} has been called.
 */
contract OffchainPriceOracle is IOffchainPriceOracle {
    struct PriceUpdate {
        address token;
        uint256 price;
        uint256 timestamp;
        uint256 nonce;
    }

    bytes32 public constant PRICE_UPDATE_TYPEHASH =
        keccak256("PriceUpdate(address token,uint256 price,uint256 timestamp,uint256 nonce)");

    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 public constant MAX_DELAY = 10 minutes;
    uint8 public constant MIN_SIGNERS = 2;
    uint8 public constant MIN_THRESHOLD = 2;

    address public owner;
    address public timelock;
    uint8 public requiredSignatures;
    uint8 public signerCount;

    mapping(address => bool) public isSigner;
    mapping(address => uint256) public prices;
    mapping(address => uint256) public updatedAt;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event SignerSet(address indexed signer, bool enabled);
    event RequiredSignaturesUpdated(uint8 oldThreshold, uint8 newThreshold);
    event TimelockSet(address indexed timelock);
    event PriceUpdated(address indexed token, uint256 price, uint256 timestamp, uint256 nonce);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "OffchainPriceOracle: not owner");
        _;
    }

    constructor(address[] memory initialSigners, uint8 threshold) {
        require(threshold >= MIN_THRESHOLD, "OffchainPriceOracle: threshold too low");
        require(initialSigners.length >= threshold, "OffchainPriceOracle: insufficient signers");
        owner = msg.sender;
        for (uint256 i = 0; i < initialSigners.length; i++) {
            address s = initialSigners[i];
            require(s != address(0), "OffchainPriceOracle: zero signer");
            if (!isSigner[s]) {
                isSigner[s] = true;
                signerCount++;
                emit SignerSet(s, true);
            }
        }
        require(signerCount >= threshold, "OffchainPriceOracle: unique signers below threshold");
        _setRequiredSignatures(threshold);

        uint256 chainId;
        assembly {
            chainId := chainid()
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OffchainPriceOracle")),
                keccak256(bytes("2")),
                chainId,
                address(this)
            )
        );
    }

    function initializeTimelock(address _timelock) external onlyOwner {
        require(_timelock != address(0), "OffchainPriceOracle: zero timelock");
        timelock = _timelock;
        emit TimelockSet(_timelock);
    }

    function setSigner(address signer, bool enabled) external {
        IntegrationMutability.requireTimelockOrOwner(timelock, owner, msg.sender);
        require(signer != address(0), "OffchainPriceOracle: zero signer");
        if (enabled && !isSigner[signer]) {
            isSigner[signer] = true;
            signerCount++;
            emit SignerSet(signer, true);
        } else if (!enabled && isSigner[signer]) {
            isSigner[signer] = false;
            signerCount--;
            emit SignerSet(signer, false);
        }
        require(signerCount >= requiredSignatures, "OffchainPriceOracle: below threshold");
    }

    function setRequiredSignatures(uint8 threshold) external {
        IntegrationMutability.requireTimelockOrOwner(timelock, owner, msg.sender);
        _setRequiredSignatures(threshold);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OffchainPriceOracle: zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function updatePrice(PriceUpdate calldata update, bytes[] calldata signatures) external {
        require(!usedNonces[update.token][update.nonce], "OffchainPriceOracle: nonce used");
        require(update.timestamp <= block.timestamp, "OffchainPriceOracle: future timestamp");
        require(block.timestamp - update.timestamp <= MAX_DELAY, "OffchainPriceOracle: stale price");
        require(signatures.length >= requiredSignatures, "OffchainPriceOracle: insufficient sigs");

        bytes32 structHash = keccak256(
            abi.encode(
                PRICE_UPDATE_TYPEHASH,
                update.token,
                update.price,
                update.timestamp,
                update.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        uint256 valid;
        address[] memory seen = new address[](signatures.length);
        for (uint256 i = 0; i < signatures.length; i++) {
            address recovered = _recoverSigner(digest, signatures[i]);
            if (!isSigner[recovered]) continue;
            bool duplicate;
            for (uint256 j = 0; j < valid; j++) {
                if (seen[j] == recovered) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;
            seen[valid] = recovered;
            valid++;
            if (valid == requiredSignatures) break;
        }
        require(valid >= requiredSignatures, "OffchainPriceOracle: threshold not met");

        usedNonces[update.token][update.nonce] = true;
        prices[update.token] = update.price;
        updatedAt[update.token] = update.timestamp;

        emit PriceUpdated(update.token, update.price, update.timestamp, update.nonce);
    }

    function getPrice(address token) external view override returns (uint256 price, uint256 timestamp) {
        return (prices[token], updatedAt[token]);
    }

    function _setRequiredSignatures(uint8 threshold) internal {
        require(threshold >= MIN_THRESHOLD, "OffchainPriceOracle: threshold too low");
        require(threshold <= signerCount || signerCount == 0, "OffchainPriceOracle: threshold too high");
        uint8 old = requiredSignatures;
        requiredSignatures = threshold;
        emit RequiredSignaturesUpdated(old, threshold);
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "OffchainPriceOracle: bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "OffchainPriceOracle: bad v");
        return ecrecover(digest, v, r, s);
    }
}
