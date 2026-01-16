/**
 * Validator Network Client
 * 
 * Collects signatures from multiple validators in parallel for instant verification.
 */

const axios = require('axios');

class ValidatorNetwork {
  constructor(validatorUrls, thresholdBps = 6600) {
    this.validators = validatorUrls; // Array of validator endpoints
    this.thresholdBps = thresholdBps; // 6600 = 66%
    this.timeout = 5000; // 5 seconds max per validator
  }

  /**
   * Submit proof to all validators and collect signatures
   * @returns {Object} { valid, signatures, totalVotingPower }
   */
  async verifyProof(proof, publicInputs) {
    console.log(`\n📡 Broadcasting to ${this.validators.length} validators...`);
    const startTime = Date.now();

    // Send to all validators in parallel
    const requests = this.validators.map(url => 
      this.requestValidation(url, proof, publicInputs)
    );

    // Wait for all responses (with timeout)
    const results = await Promise.allSettled(requests);

    // Filter successful validations
    const validations = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    console.log(`✅ Received ${validations.length}/${this.validators.length} responses (${Date.now() - startTime}ms)`);

    // Calculate total voting power
    let totalVotingPower = 0n;
    let validVotingPower = 0n;
    
    for (const v of validations) {
      const power = BigInt(v.votingPower);
      totalVotingPower += power;
      if (v.valid) {
        validVotingPower += power;
      }
    }

    // Check if threshold is met
    const validPercentage = Number((validVotingPower * 10000n) / totalVotingPower) / 100;
    const thresholdMet = (validVotingPower * 10000n) >= (totalVotingPower * BigInt(this.thresholdBps));

    console.log(`📊 Consensus: ${validPercentage.toFixed(2)}% voted VALID (threshold: ${this.thresholdBps / 100}%)`);

    if (!thresholdMet) {
      console.log(`❌ Threshold NOT met - proof REJECTED`);
      return {
        valid: false,
        signatures: [],
        totalVotingPower: totalVotingPower.toString(),
        validVotingPower: validVotingPower.toString(),
        reason: 'Threshold not met'
      };
    }

    // Filter only VALID signatures
    const validSignatures = validations
      .filter(v => v.valid)
      .map(v => ({
        validator: v.validator,
        votingPower: v.votingPower,
        signature: v.signature
      }));

    console.log(`✅ Proof ACCEPTED with ${validSignatures.length} signatures`);

    return {
      valid: true,
      signatures: validSignatures,
      totalVotingPower: totalVotingPower.toString(),
      validVotingPower: validVotingPower.toString()
    };
  }

  /**
   * Request validation from a single validator
   */
  async requestValidation(validatorUrl, proof, publicInputs) {
    try {
      const response = await axios.post(
        `${validatorUrl}/verify`,
        { proof, publicInputs },
        { timeout: this.timeout }
      );

      return response.data;
    } catch (err) {
      console.warn(`⚠️  Validator ${validatorUrl} failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Health check all validators
   */
  async checkHealth() {
    console.log(`\n🏥 Checking ${this.validators.length} validators...`);
    
    const checks = this.validators.map(async (url) => {
      try {
        const response = await axios.get(`${url}/health`, { timeout: 2000 });
        console.log(`  ✅ ${url}: ${response.data.validator}`);
        return { url, status: 'online', data: response.data };
      } catch (err) {
        console.log(`  ❌ ${url}: ${err.message}`);
        return { url, status: 'offline', error: err.message };
      }
    });

    return await Promise.all(checks);
  }
}

module.exports = ValidatorNetwork;
