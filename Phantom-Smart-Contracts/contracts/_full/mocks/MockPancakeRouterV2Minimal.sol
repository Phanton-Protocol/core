// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Minimal Pancake V2-style router for Hardhat tests (Module 2 adaptor paths).
 * @dev Pulls `tokenIn` from `msg.sender` (the adaptor) and sends `tokenOut` 1:1 to `to`.
 */
contract MockPancakeRouterV2Minimal {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockRouter: path");
        IERC20 tIn = IERC20(path[0]);
        IERC20 tOut = IERC20(path[1]);
        require(tIn.transferFrom(msg.sender, address(this), amountIn), "MockRouter: pull in");
        require(tOut.transfer(to, amountIn), "MockRouter: push out");
        require(amountIn >= amountOutMin, "MockRouter: slippage");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockRouter: path");
        IERC20 tOut = IERC20(path[1]);
        require(tOut.transfer(to, msg.value), "MockRouter: eth out");
        require(msg.value >= amountOutMin, "MockRouter: slippage");
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = msg.value;
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address payable to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockRouter: path");
        IERC20 tIn = IERC20(path[0]);
        require(tIn.transferFrom(msg.sender, address(this), amountIn), "MockRouter: pull in");
        (bool ok,) = to.call{value: amountIn}("");
        require(ok, "MockRouter: eth");
        require(amountIn >= amountOutMin, "MockRouter: slippage");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external pure returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length == 0 ? 2 : path.length);
        amounts[amounts.length - 1] = amountIn;
    }

    receive() external payable {}
}
