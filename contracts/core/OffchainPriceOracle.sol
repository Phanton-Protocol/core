// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOffchainPriceOracle.sol";

/**
 * @title OffchainPriceOracle
 * @notice Accepts signed price updates from a trusted signer
 * @dev Price is USD with 8 decimals. Signature uses EIP-712.
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

    address public owner;
    address public signer;

    mapping(address => uint256) public prices;
    mapping(address => uint256) public updatedAt;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event SignerUpdated(address indexed newSigner);
    event PriceUpdated(address indexed token, uint256 price, uint256 timestamp, uint256 nonce);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "OffchainPriceOracle: not owner");
        _;
    }

    constructor(address _signer) {
        require(_signer != address(0), "OffchainPriceOracle: zero signer");
        owner = msg.sender;
        signer = _signer;

        uint256 chainId;
        assembly {
            chainId := chainid()
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OffchainPriceOracle")),
                keccak256(bytes("1")),
                chainId,
                address(this)
            )
        );
    }

    function setSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "OffchainPriceOracle: zero signer");
        signer = newSigner;
        emit SignerUpdated(newSigner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OffchainPriceOracle: zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function updatePrice(PriceUpdate calldata update, bytes calldata signature) external {
        require(!usedNonces[update.token][update.nonce], "OffchainPriceOracle: nonce used");
        require(update.timestamp <= block.timestamp, "OffchainPriceOracle: future timestamp");
        require(block.timestamp - update.timestamp <= MAX_DELAY, "OffchainPriceOracle: stale price");

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

        address recovered = _recoverSigner(digest, signature);
        require(recovered == signer, "OffchainPriceOracle: invalid signature");

        usedNonces[update.token][update.nonce] = true;
        prices[update.token] = update.price;
        updatedAt[update.token] = update.timestamp;

        emit PriceUpdated(update.token, update.price, update.timestamp, update.nonce);
    }

    function getPrice(address token) external view override returns (uint256 price, uint256 timestamp) {
        return (prices[token], updatedAt[token]);
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
