

const axios = require('axios');
const crypto = require("crypto");

class ValidatorNetwork {
  constructor(validatorUrls, thresholdBps = 6600) {
    this.validators = validatorUrls; 

    this.thresholdBps = thresholdBps; 

    this.timeout = Number(process.env.VALIDATOR_TIMEOUT_MS || 20000); 

    this.maxRetries = Number(process.env.VALIDATOR_RETRIES || 3);
    this.retryBaseMs = Number(process.env.VALIDATOR_RETRY_BASE_MS || 500);
  }

  async verifyProof(proof, publicInputs) {
    console.log(`\n📡 Broadcasting to ${this.validators.length} validators...`);
    const startTime = Date.now();

    const requests = this.validators.map(url => 
      this.requestValidation(url, proof, publicInputs)
    );

    const results = await Promise.allSettled(requests);

    results.forEach((result, i) => {
      const url = this.validators[i];
      if (result.status === 'fulfilled' && result.value) {
        console.log(`🧾 Validator response from ${url}:`, {
          valid: result.value.valid,
          hasSignature: !!result.value.signature,
          votingPower: result.value.votingPower,
          aggregated: !!result.value.aggregated,
        });
      } else if (result.status === 'fulfilled') {
        console.log(`🧾 Validator response from ${url}: null`);
      } else {
        console.log(`🧾 Validator error from ${url}:`, result.reason?.message || result.reason);
      }
    });

    const validations = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    console.log(`✅ Received ${validations.length}/${this.validators.length} responses (${Date.now() - startTime}ms)`);

    const aggregated = validations.find(v => v.aggregated);
    if (aggregated) {
      const totalVotingPower = BigInt(aggregated.totalVotingPower);
      const validVotingPower = BigInt(aggregated.validVotingPower);
      const thresholdMet = totalVotingPower > 0n && (validVotingPower * 10000n) >= (totalVotingPower * BigInt(this.thresholdBps));
      if (!thresholdMet) {
        console.log(`❌ Coordinator threshold NOT met - proof REJECTED`);
        return {
          valid: false,
          signatures: [],
          totalVotingPower: aggregated.totalVotingPower,
          validVotingPower: aggregated.validVotingPower,
          reason: 'Threshold not met'
        };
      }
      const validSignatures = (aggregated.signatures || []).filter(s => s.signature);
      console.log(`✅ Coordinator proof ACCEPTED (${validSignatures.length} stakers)`);
      return {
        valid: true,
        signatures: validSignatures,
        totalVotingPower: aggregated.totalVotingPower,
        validVotingPower: aggregated.validVotingPower
      };
    }

    let totalVotingPower = 0n;
    let validVotingPower = 0n;
    
    for (const v of validations) {
      const power = BigInt(v.votingPower);
      totalVotingPower += power;
      if (v.valid) {
        validVotingPower += power;
      }
    }

    if (totalVotingPower === 0n) {
      console.log(`❌ No validator voting power - proof REJECTED`);
      return {
        valid: false,
        signatures: [],
        totalVotingPower: "0",
        validVotingPower: "0",
        reason: 'No validator voting power'
      };
    }

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

    const validSignatures = validations
      .filter(v => v.valid)
      .map(v => ({
        validator: v.validator,
        votingPower: v.votingPower,
        signature: v.signature,
        timestamp: v.timestamp
      }));

    console.log(`✅ Proof ACCEPTED with ${validSignatures.length} signatures`);

    return {
      valid: true,
      signatures: validSignatures,
      totalVotingPower: totalVotingPower.toString(),
      validVotingPower: validVotingPower.toString()
    };
  }

  async requestValidation(validatorUrl, proof, publicInputs) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.post(
          `${validatorUrl}/verify`,
          { proof, publicInputs },
          { timeout: this.timeout }
        );
        return response.data;
      } catch (err) {
        console.warn(`⚠️  Validator ${validatorUrl} attempt ${attempt}/${this.maxRetries} failed: ${err.message}`);
        if (attempt < this.maxRetries) {
          const delay = this.retryBaseMs * (2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    return null;
  }

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

  async verifyAttestationQuorum(attestation, binding, opts = {}) {
    const requiredQuorumBps = Number(opts.requiredQuorumBps || process.env.ATTESTATION_REQUIRED_QUORUM_BPS || 6600);
    const policyVersion = String(opts.policyVersion || process.env.ATTESTATION_POLICY_VERSION || "v1");
    if (!attestation || typeof attestation !== "object") {
      return {
        valid: false,
        reasonCode: "ATTESTATION_MISSING",
        requiredQuorumBps,
        signerCount: 0,
        signerSetHash: null,
      };
    }
    const expectedBinding = {
      matchHash: String(binding?.matchHash || ""),
      executionKey: String(binding?.executionKey || ""),
      fheDecisionHash: String(binding?.fheDecisionHash || ""),
      policyVersion,
    };
    const providedBinding = attestation.binding || {};
    if (
      String(providedBinding.matchHash || "") !== expectedBinding.matchHash ||
      String(providedBinding.executionKey || "") !== expectedBinding.executionKey ||
      String(providedBinding.fheDecisionHash || "") !== expectedBinding.fheDecisionHash ||
      String(providedBinding.policyVersion || "") !== expectedBinding.policyVersion
    ) {
      return {
        valid: false,
        reasonCode: "ATTESTATION_INVALID",
        requiredQuorumBps,
        signerCount: 0,
        signerSetHash: null,
      };
    }
    const signers = Array.isArray(attestation.signers) ? attestation.signers : [];
    const normalized = signers
      .map((s) => ({
        id: String(s?.id || "").trim(),
        votingPowerBps: Number(s?.votingPowerBps || 0),
        valid: Boolean(s?.valid),
      }))
      .filter((s) => s.id && Number.isFinite(s.votingPowerBps) && s.votingPowerBps > 0);
    const validVotingPower = normalized.filter((s) => s.valid).reduce((a, s) => a + s.votingPowerBps, 0);
    const signerSetHash = normalized.length
      ? crypto.createHash("sha256").update(normalized.map((s) => `${s.id}:${s.votingPowerBps}:${s.valid ? 1 : 0}`).sort().join("|")).digest("hex")
      : null;
    if (validVotingPower < requiredQuorumBps) {
      return {
        valid: false,
        reasonCode: "ATTESTATION_QUORUM_INSUFFICIENT",
        requiredQuorumBps,
        signerCount: normalized.length,
        signerSetHash,
        validVotingPowerBps: validVotingPower,
      };
    }
    return {
      valid: true,
      reasonCode: null,
      requiredQuorumBps,
      signerCount: normalized.length,
      signerSetHash,
      validVotingPowerBps: validVotingPower,
    };
  }
}

module.exports = ValidatorNetwork;
