// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../types/Types.sol";

/**
 * @title InternalMatchIntentLib
 * @notice Phase 7 deploy support: extracts EIP-712 digest computation,
 *         secp256k1 attestation recovery, decision-hash binding, proof-context
 *         binding and user-intent verification for internal matching from
 *         {ShieldedPool} into a separate linked library so the main contract
 *         bytecode fits within EIP-170 (24,576 bytes) on BSC testnet.
 *
 * @dev Functions are declared `public` so the Solidity linker emits a
 *      delegatecall placeholder; the library is deployed once and linked into
 *      ShieldedPool at deploy-time. `address(this)` and `block.chainid` inside
 *      the library still refer to the calling ShieldedPool, so EIP-712 domain
 *      separators are computed correctly.
 *
 *      The `PoolErr(uint256)` error selector matches the one declared in
 *      {ShieldedPool}, so reverts thrown from the library surface to callers
 *      with the same error signature/code as before this refactor.
 */
library InternalMatchIntentLib {
    error PoolErr(uint8 code);

    event InternalMatchSettled(
        bytes32 indexed matchHash,
        bytes32 indexed decisionHash,
        bytes32 indexed executionKey,
        bytes32 makerOrderId,
        bytes32 takerOrderId,
        address relayer
    );

    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "InternalMatchIntent(address user,uint8 side,uint256 inputAssetID,uint256 outputAssetID,uint256 amount,uint256 limitPrice,uint256 nonce,uint256 deadline,bytes32 ciphertextHash)"
    );
    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "InternalMatchAttestation(bytes32 decisionHash,bytes32 matchHash,bytes32 executionKey,address relayer,bytes32 signerSetHash,uint256 deadline,uint256 nonce)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant INTENT_DOMAIN_NAME_HASH = keccak256("PhantomInternalMatchIntent");
    bytes32 internal constant INTENT_DOMAIN_VERSION_HASH = keccak256("1");
    bytes32 internal constant ATTESTATION_DOMAIN_NAME_HASH = keccak256("PhantomInternalMatchAttestation");
    bytes32 internal constant ATTESTATION_DOMAIN_VERSION_HASH = keccak256("1");
    bytes32 internal constant PROOF_CONTEXT_TAG = keccak256("PHANTOM_INTERNAL_MATCH_PROOF_CONTEXT_V1");

    bytes32 internal constant RELAYER_ATTESTATION_TYPEHASH = keccak256(
        "RelayerSwapAttestation(bytes32 proofHash,bytes32 nullifier,uint256 inputAssetID,uint256 outputAssetIDSwap,uint256 swapAmount,uint256 minOutputAmountSwap,address relayer,address pool,uint256 chainId,uint256 deadline,uint256 nonce)"
    );
    bytes32 internal constant RELAYER_ATTESTATION_HASH_FIRST_TYPEHASH = keccak256(
        "RelayerSwapAttestationHashFirst(bytes32 proofHash,bytes32 publicInputHash,address relayer,address pool,uint256 chainId,uint256 deadline,uint256 nonce)"
    );
    bytes32 internal constant RELAYER_ATTESTATION_NAME_HASH = keccak256("PhantomRelayerAttestation");
    bytes32 internal constant RELAYER_ATTESTATION_VERSION_HASH = keccak256("1");

    event RelayerAttestationVerified(address indexed relayer, uint256 indexed nonce, bytes32 digest);

    function computeIntentDigest(InternalMatchIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                intent.side,
                intent.inputAssetID,
                intent.outputAssetID,
                intent.amount,
                intent.limitPrice,
                intent.nonce,
                intent.deadline,
                intent.ciphertextHash
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                INTENT_DOMAIN_NAME_HASH,
                INTENT_DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function computeAttestationDigest(
        bytes32 decisionHash,
        bytes32 matchHash,
        bytes32 executionKey,
        address relayer,
        bytes32 signerSetHash,
        uint256 deadline,
        uint256 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                decisionHash,
                matchHash,
                executionKey,
                relayer,
                signerSetHash,
                deadline,
                nonce
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                ATTESTATION_DOMAIN_NAME_HASH,
                ATTESTATION_DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function computeDecisionHash(
        InternalMatchDecisionArtifact calldata artifact
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                artifact.makerOrderId,
                artifact.takerOrderId,
                artifact.makerInputCommitment,
                artifact.takerInputCommitment,
                artifact.makerInputAssetID,
                artifact.takerInputAssetID,
                artifact.executionPrice,
                artifact.quantity,
                artifact.makerIsSell,
                artifact.takerIsBuy,
                artifact.approved,
                artifact.decidedAt,
                artifact.decisionNonce,
                artifact.signerSetHash
            )
        );
    }

    function computeProofContextHash(
        bytes32 decisionHash,
        bytes32 matchHash,
        bytes32 executionKey,
        JoinSplitPublicInputs memory inputs
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PROOF_CONTEXT_TAG,
                decisionHash,
                matchHash,
                executionKey,
                inputs.nullifier,
                inputs.inputCommitment,
                inputs.outputCommitmentSwap,
                inputs.outputCommitmentChange,
                inputs.inputAssetID,
                inputs.outputAssetIDSwap,
                inputs.outputAssetIDChange,
                inputs.swapAmount
            )
        );
    }

    function recoverAttestationSigner(bytes32 digest, bytes memory signature) public pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    /**
     * @notice Verifies a SignedInternalMatchIntent against the expected match
     *         terms and recovers the signer.
     * @dev    Reverts with `PoolErr(uint256)` whose code mirrors the
     *         pre-refactor revert codes in {ShieldedPool} so external
     *         tests/clients see the same behavior. Returns nothing on success.
     *
     *         The `isMaker` flag distinguishes maker (code 59) and taker (60)
     *         signature failures.
     */
    function verifyUserIntent(
        SignedInternalMatchIntent calldata signed,
        uint256 expectedInputAssetID,
        uint256 expectedOutputAssetID,
        uint256 minAmount,
        uint256 executionPrice,
        bool expectedIsSell,
        bool isMaker
    ) internal view {
        InternalMatchIntent calldata intent = signed.intent;
        if (intent.user == address(0)) revert PoolErr(isMaker ? 59 : 60);
        if (intent.deadline < block.timestamp) revert PoolErr(63);
        if (intent.inputAssetID != expectedInputAssetID || intent.outputAssetID != expectedOutputAssetID) {
            revert PoolErr(61);
        }
        if (intent.amount < minAmount) revert PoolErr(61);
        if (expectedIsSell) {
            if (intent.side != 0 || executionPrice < intent.limitPrice) revert PoolErr(61);
        } else {
            if (intent.side != 1 || executionPrice > intent.limitPrice) revert PoolErr(61);
        }
        bytes32 digest = computeIntentDigest(intent);
        address recovered = recoverAttestationSigner(digest, signed.signature);
        if (recovered == address(0) || recovered != intent.user) {
            revert PoolErr(isMaker ? 59 : 60);
        }
    }

    /**
     * @notice Performs the full Phase 1+ internal-match settlement validation,
     *         marks all uniqueness/nonce storage entries as used and emits
     *         {InternalMatchSettled}.
     * @dev Called via DELEGATECALL by {ShieldedPool.internalMatchSettle}; all
     *      storage references resolve to the calling pool's storage and the
     *      emitted event is attributed to the pool address. Reverts use the
     *      same `PoolErr(code)` selector as the pool so external callers see
     *      identical revert reasons.
     */
    function processInternalMatchSettle(
        InternalMatchSettlementData calldata d,
        address relayer,
        mapping(bytes32 => bool) storage usedMatchHashes,
        mapping(bytes32 => bool) storage usedDecisionHashes,
        mapping(address => mapping(uint256 => bool)) storage attestationNonceUsed,
        mapping(address => mapping(uint256 => bool)) storage intentNonceUsed
    ) public {
        if (usedMatchHashes[d.matchHash]) revert PoolErr(52);
        if (usedDecisionHashes[d.decisionHash]) revert PoolErr(53);
        if (d.attestationDeadline < block.timestamp) revert PoolErr(54);
        if (attestationNonceUsed[relayer][d.attestationNonce]) revert PoolErr(55);

        if (computeDecisionHash(d.artifact) != d.decisionHash) revert PoolErr(56);
        if (!d.artifact.approved) revert PoolErr(57);

        if (d.artifact.makerInputCommitment != d.makerSwapData.publicInputs.inputCommitment) revert PoolErr(56);
        if (d.artifact.takerInputCommitment != d.takerSwapData.publicInputs.inputCommitment) revert PoolErr(56);
        if (d.artifact.makerInputAssetID != d.makerSwapData.publicInputs.inputAssetID) revert PoolErr(56);
        if (d.artifact.takerInputAssetID != d.takerSwapData.publicInputs.inputAssetID) revert PoolErr(56);
        if (d.artifact.executionPrice == 0 || d.artifact.quantity == 0) revert PoolErr(56);
        if (!d.artifact.makerIsSell || !d.artifact.takerIsBuy) revert PoolErr(56);
        if (d.artifact.quantity > d.takerSwapData.publicInputs.swapAmount) revert PoolErr(56);
        if (d.artifact.quantity > d.makerSwapData.publicInputs.swapAmount) revert PoolErr(56);

        if (
            d.takerSwapData.proofContextHash == bytes32(0) ||
            d.takerSwapData.proofContextHash !=
                computeProofContextHash(d.decisionHash, d.matchHash, d.executionKey, d.takerSwapData.publicInputs)
        ) {
            revert PoolErr(58);
        }
        if (
            d.makerSwapData.proofContextHash == bytes32(0) ||
            d.makerSwapData.proofContextHash !=
                computeProofContextHash(d.decisionHash, d.matchHash, d.executionKey, d.makerSwapData.publicInputs)
        ) {
            revert PoolErr(58);
        }

        {
            bytes32 digest = computeAttestationDigest(
                d.decisionHash,
                d.matchHash,
                d.executionKey,
                relayer,
                d.artifact.signerSetHash,
                d.attestationDeadline,
                d.attestationNonce
            );
            address recovered = recoverAttestationSigner(digest, d.attestationSig);
            if (recovered != relayer) revert PoolErr(51);
        }
        if (d.artifact.signerSetHash != keccak256(abi.encodePacked(relayer))) revert PoolErr(56);

        if (intentNonceUsed[d.makerSignedIntent.intent.user][d.makerSignedIntent.intent.nonce]) revert PoolErr(62);
        if (intentNonceUsed[d.takerSignedIntent.intent.user][d.takerSignedIntent.intent.nonce]) revert PoolErr(62);
        verifyUserIntent(
            d.makerSignedIntent,
            d.artifact.makerInputAssetID,
            d.artifact.takerInputAssetID,
            d.artifact.quantity,
            d.artifact.executionPrice,
            d.artifact.makerIsSell,
            true
        );
        verifyUserIntent(
            d.takerSignedIntent,
            d.artifact.takerInputAssetID,
            d.artifact.makerInputAssetID,
            d.artifact.quantity,
            d.artifact.executionPrice,
            !d.artifact.takerIsBuy,
            false
        );

        attestationNonceUsed[relayer][d.attestationNonce] = true;
        intentNonceUsed[d.makerSignedIntent.intent.user][d.makerSignedIntent.intent.nonce] = true;
        intentNonceUsed[d.takerSignedIntent.intent.user][d.takerSignedIntent.intent.nonce] = true;
        usedMatchHashes[d.matchHash] = true;
        usedDecisionHashes[d.decisionHash] = true;

        emit InternalMatchSettled(
            d.matchHash,
            d.decisionHash,
            d.executionKey,
            d.artifact.makerOrderId,
            d.artifact.takerOrderId,
            relayer
        );
    }

    /**
     * @notice EIP-712 verification for the per-swap relayer attestation that
     *         binds the relayer to the proof + public inputs. Marks the
     *         attestation nonce as used and emits {RelayerAttestationVerified}.
     * @dev    Tries the new "hash-first" digest, then falls back to the legacy
     *         digest variant for backwards compatibility with older relayer
     *         signing pipelines, exactly mirroring the pre-extraction inline
     *         logic in {ShieldedPool}.
     */
    function verifyRelayerSwapAttestation(
        JoinSplitSwapData calldata swapData,
        JoinSplitPublicInputs memory inputs,
        address relayer,
        address sender,
        bytes32 publicInputHash,
        mapping(address => mapping(uint256 => bool)) storage relayerAttestationNonceUsed
    ) public {
        if (swapData.relayerAttestationSig.length == 0) revert PoolErr(48);
        if (swapData.relayerAttestationDeadline < block.timestamp) revert PoolErr(49);
        if (relayerAttestationNonceUsed[relayer][swapData.relayerAttestationNonce]) revert PoolErr(50);

        bytes32 proofHash = keccak256(abi.encode(swapData.proof.a, swapData.proof.b, swapData.proof.c));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                RELAYER_ATTESTATION_NAME_HASH,
                RELAYER_ATTESTATION_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 hashFirstStructHash = keccak256(
            abi.encode(
                RELAYER_ATTESTATION_HASH_FIRST_TYPEHASH,
                proofHash,
                publicInputHash,
                relayer,
                address(this),
                block.chainid,
                swapData.relayerAttestationDeadline,
                swapData.relayerAttestationNonce
            )
        );
        bytes32 hashFirstDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, hashFirstStructHash));
        bytes32 structHash = keccak256(
            abi.encode(
                RELAYER_ATTESTATION_TYPEHASH,
                proofHash,
                inputs.nullifier,
                inputs.inputAssetID,
                inputs.outputAssetIDSwap,
                inputs.swapAmount,
                inputs.minOutputAmountSwap,
                relayer,
                address(this),
                block.chainid,
                swapData.relayerAttestationDeadline,
                swapData.relayerAttestationNonce
            )
        );
        bytes32 legacyDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address recovered = recoverAttestationSigner(hashFirstDigest, swapData.relayerAttestationSig);
        bytes32 usedDigest = hashFirstDigest;
        if (recovered != sender || recovered != relayer) {
            recovered = recoverAttestationSigner(legacyDigest, swapData.relayerAttestationSig);
            usedDigest = legacyDigest;
            if (recovered != sender || recovered != relayer) revert PoolErr(51);
        }

        relayerAttestationNonceUsed[relayer][swapData.relayerAttestationNonce] = true;
        emit RelayerAttestationVerified(relayer, swapData.relayerAttestationNonce, usedDigest);
    }
}
