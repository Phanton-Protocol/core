/**
 * Validator Server - Runs on staker's machine to verify proofs instantly
 * 
 * What it does:
 * 1. Listens for proof verification requests from relayers
 * 2. Verifies proofs off-chain using snarkjs
 * 3. Signs the result with validator's private key
 * 4. Returns signature to relayer
 * 
 * Stakers earn rewards for honest validation, get slashed for dishonest validation.
 */

const express = require('express');
const { ethers } = require('ethers');
const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');

// Configuration
const VALIDATOR_PORT = process.env.VALIDATOR_PORT || 6000;
const VALIDATOR_PRIVATE_KEY = process.env.VALIDATOR_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545';
const VERIFICATION_KEY_PATH = process.env.VERIFICATION_KEY_PATH || './circuits/verification_key.json';

if (!VALIDATOR_PRIVATE_KEY) {
  throw new Error('Missing VALIDATOR_PRIVATE_KEY');
}

// Setup wallet
const wallet = new ethers.Wallet(VALIDATOR_PRIVATE_KEY);
const validatorAddress = wallet.address;

console.log(`🔐 Validator Address: ${validatorAddress}`);
console.log(`⚡ Starting validator server on port ${VALIDATOR_PORT}...`);

// Load verification key
let vKey;
try {
  vKey = JSON.parse(fs.readFileSync(VERIFICATION_KEY_PATH, 'utf-8'));
  console.log('✅ Verification key loaded');
} catch (err) {
  console.error('❌ Failed to load verification key:', err.message);
  process.exit(1);
}

// Setup Express
const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    validator: validatorAddress,
    uptime: process.uptime()
  });
});

/**
 * POST /verify
 * 
 * Request body:
 * {
 *   "proof": { "a": [...], "b": [...], "c": [...] },
 *   "publicInputs": [...]
 * }
 * 
 * Response:
 * {
 *   "valid": true,
 *   "validator": "0x...",
 *   "votingPower": "100000000000000000000000",
 *   "signature": "0x...",
 *   "proofHash": "0x..."
 * }
 */
app.post('/verify', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { proof, publicInputs } = req.body;
    
    if (!proof || !publicInputs) {
      return res.status(400).json({ error: 'Missing proof or publicInputs' });
    }
    
    console.log(`\n🔍 Verifying proof...`);
    
    // 1. Verify proof off-chain using snarkjs
    const isValid = await verifyProofOffChain(proof, publicInputs);
    
    console.log(`${isValid ? '✅' : '❌'} Proof is ${isValid ? 'VALID' : 'INVALID'} (${Date.now() - startTime}ms)`);
    
    // 2. Calculate proof hash (same as on-chain)
    const proofHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256[2]', 'uint256[2][2]', 'uint256[2]', 'uint256[]'],
        [proof.a, proof.b, proof.c, publicInputs]
      )
    );
    
    // 3. Get voting power from staking contract
    const votingPower = await getVotingPower(validatorAddress);
    
    console.log(`💪 Voting power: ${ethers.formatEther(votingPower)} tokens`);
    
    // 4. Sign the result
    const message = ethers.keccak256(
      ethers.solidityPacked(['bytes32', 'bool'], [proofHash, isValid])
    );
    const signature = await wallet.signMessage(ethers.getBytes(message));
    
    console.log(`✍️  Signed result (${signature.slice(0, 10)}...)`);
    
    // 5. Return signature to relayer
    res.json({
      valid: isValid,
      validator: validatorAddress,
      votingPower: votingPower.toString(),
      signature,
      proofHash,
      verificationTime: Date.now() - startTime
    });
    
  } catch (err) {
    console.error('❌ Verification error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Verify proof off-chain using snarkjs
 */
async function verifyProofOffChain(proof, publicInputs) {
  try {
    // Convert proof format from Solidity to snarkjs
    const proofSnarkJS = {
      pi_a: proof.a.slice(0, 2), // Remove the third element (it's always 1 in G1)
      pi_b: [
        [proof.b[0][1], proof.b[0][0]], // Swap order for G2
        [proof.b[1][1], proof.b[1][0]]
      ],
      pi_c: proof.c.slice(0, 2),
      protocol: "groth16",
      curve: "bn128"
    };
    
    // Verify using snarkjs
    const isValid = await snarkjs.groth16.verify(vKey, publicInputs, proofSnarkJS);
    
    return isValid;
  } catch (err) {
    console.error('Verification failed:', err.message);
    return false;
  }
}

/**
 * Get validator's voting power from staking contract
 */
async function getVotingPower(address) {
  try {
    // For now, return mock voting power
    // In production, query the RelayerStaking contract
    return ethers.parseEther('100000'); // 100k tokens
    
    /* Production code:
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const stakingContract = new ethers.Contract(
      STAKING_ADDRESS,
      ['function stakedBalance(address) view returns (uint256)'],
      provider
    );
    return await stakingContract.stakedBalance(address);
    */
  } catch (err) {
    console.error('Failed to get voting power:', err.message);
    return ethers.parseEther('0');
  }
}

// Start server
app.listen(VALIDATOR_PORT, () => {
  console.log(`\n✅ Validator server running!`);
  console.log(`📡 Endpoint: http://localhost:${VALIDATOR_PORT}/verify`);
  console.log(`\n📋 To test:`);
  console.log(`   curl -X POST http://localhost:${VALIDATOR_PORT}/verify \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"proof": {...}, "publicInputs": [...]}'`);
  console.log(`\n🎯 Waiting for proof verification requests...\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down validator server...');
  process.exit(0);
});
