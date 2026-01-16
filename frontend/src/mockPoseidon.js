// Temporary mock Poseidon for UI testing
// Replace with real circomlibjs Poseidon for production

export default async function buildMockPoseidon() {
  // Mock field modulus (BN128 scalar field)
  const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  
  function mockHash(inputs, initState, nOut) {
    // Return safe default for invalid inputs (don't throw during initialization)
    if (!Array.isArray(inputs) || inputs.length === 0) {
      if (nOut && nOut > 1) return new Array(nOut).fill(12345678901234567890n % p);
      return 12345678901234567890n % p;
    }
    
    // Simple mock: XOR all inputs and take modulo p
    let result = 0n;
    for (const input of inputs) {
      const val = typeof input === 'bigint' ? input : BigInt(input || 0);
      result = (result ^ val) % p;
    }
    // Add a constant to make it non-zero
    result = (result + 12345678901234567890n) % p;
    
    if (nOut && nOut > 1) {
      return new Array(nOut).fill(result);
    }
    return result;
  }
  
  // Add F property to match circomlibjs interface
  mockHash.F = {
    p: p,
    zero: 0n,
    one: 1n,
    e: (x) => {
      if (typeof x === 'bigint') return x % p;
      if (typeof x === 'number') return BigInt(x) % p;
      if (typeof x === 'string') return BigInt(x) % p;
      return 0n;
    }
  };
  
  return mockHash;
}
