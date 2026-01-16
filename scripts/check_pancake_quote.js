const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const ROUTER = process.env.PANCAKE_ROUTER || "0x9ac64cc6e4415144c455bd8e4837fea55603e5c3";
const WBNB = process.env.WBNB || "0xae13d989dac2f0debff460ac112a837c89baa7cd";

async function main() {
  const [, , tokenInArg, tokenOutArg, amountArg] = process.argv;
  if (!RPC_URL) throw new Error("Missing RPC_URL");
  if (!tokenInArg || !tokenOutArg || !amountArg) {
    throw new Error("Usage: node scripts/check_pancake_quote.js <tokenIn> <tokenOut> <amountIn>");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const tokenIn = tokenInArg === "BNB" ? ethers.ZeroAddress : tokenInArg;
  const tokenOut = tokenOutArg === "BNB" ? ethers.ZeroAddress : tokenOutArg;

  const erc20Abi = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
  const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"];

  const inAddr = tokenIn === ethers.ZeroAddress ? WBNB : tokenIn;
  const outAddr = tokenOut === ethers.ZeroAddress ? WBNB : tokenOut;

  let inDecimals = 18;
  let inSymbol = "BNB";
  if (tokenIn !== ethers.ZeroAddress) {
    try {
      const inToken = new ethers.Contract(tokenIn, erc20Abi, provider);
      [inDecimals, inSymbol] = await Promise.all([inToken.decimals(), inToken.symbol()]);
    } catch {
      inDecimals = 18;
      inSymbol = "TOKEN";
    }
  }
  let outDecimals = 18;
  let outSymbol = "BNB";
  if (tokenOut !== ethers.ZeroAddress) {
    try {
      const outToken = new ethers.Contract(tokenOut, erc20Abi, provider);
      [outDecimals, outSymbol] = await Promise.all([outToken.decimals(), outToken.symbol()]);
    } catch {
      outDecimals = 18;
      outSymbol = "TOKEN";
    }
  }

  const amountIn = ethers.parseUnits(amountArg, inDecimals);
  const router = new ethers.Contract(ROUTER, routerAbi, provider);
  const path = [inAddr, outAddr];
  const amounts = await router.getAmountsOut(amountIn, path);
  const amountOut = amounts[amounts.length - 1];

  console.log("Router:", ROUTER);
  console.log("Path:", path.join(" -> "));
  console.log("Amount In:", ethers.formatUnits(amountIn, inDecimals), inSymbol);
  console.log("Amount Out:", ethers.formatUnits(amountOut, outDecimals), outSymbol);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
