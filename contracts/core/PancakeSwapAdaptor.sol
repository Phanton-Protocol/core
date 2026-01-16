// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPancakeSwapAdaptor.sol";
import "../types/Types.sol";

/**
 * @title PancakeSwapAdaptor
 * @notice Adaptor for executing swaps on PancakeSwap V3
 * @dev Handles both BNB and ERC20 token swaps
 */
contract PancakeSwapAdaptor is IPancakeSwapAdaptor {
    // PancakeSwap V2 Router addresses
    address public router;
    address public wbnb;

    address public owner;

    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "PancakeSwapAdaptor: not owner");
        _;
    }

    constructor(address _router, address _wbnb) {
        owner = msg.sender;
        router = _router;
        wbnb = _wbnb;
    }

    /**
     * @notice Executes a swap on PancakeSwap V3
     * @param swapParams Swap parameters
     * @return amountOut Actual amount received from swap
     */
    function executeSwap(
        SwapParams calldata swapParams
    ) external payable override returns (uint256 amountOut) {
        require(swapParams.amountIn > 0, "PancakeSwapAdaptor: zero amount");
        require(swapParams.tokenOut != address(0), "PancakeSwapAdaptor: invalid token out");
        
        bool isBNBIn = swapParams.tokenIn == address(0);
        bool isBNBOut = swapParams.tokenOut == address(0);

        address[] memory path = _getPath(swapParams);
        uint256 deadline = block.timestamp + 300;

        if (isBNBIn) {
            require(msg.value >= swapParams.amountIn, "PancakeSwapAdaptor: insufficient BNB");
            uint256[] memory amounts = IPancakeRouter02(router).swapExactETHForTokens{value: swapParams.amountIn}(
                swapParams.minAmountOut,
                path,
                msg.sender,
                deadline
            );
            amountOut = amounts[amounts.length - 1];
        } else if (isBNBOut) {
            IERC20(swapParams.tokenIn).transferFrom(msg.sender, address(this), swapParams.amountIn);
            IERC20(swapParams.tokenIn).approve(router, swapParams.amountIn);
            uint256[] memory amounts = IPancakeRouter02(router).swapExactTokensForETH(
                swapParams.amountIn,
                swapParams.minAmountOut,
                path,
                msg.sender,
                deadline
            );
            amountOut = amounts[amounts.length - 1];
        } else {
            IERC20(swapParams.tokenIn).transferFrom(msg.sender, address(this), swapParams.amountIn);
            IERC20(swapParams.tokenIn).approve(router, swapParams.amountIn);
            uint256[] memory amounts = IPancakeRouter02(router).swapExactTokensForTokens(
                swapParams.amountIn,
                swapParams.minAmountOut,
                path,
                msg.sender,
                deadline
            );
            amountOut = amounts[amounts.length - 1];
        }
        
        require(amountOut >= swapParams.minAmountOut, "PancakeSwapAdaptor: slippage exceeded");
        
        emit SwapExecuted(swapParams.tokenIn, swapParams.tokenOut, swapParams.amountIn, amountOut);
    }

    /**
     * @notice Gets the expected output amount for a swap
     * @param swapParams Swap parameters
     * @return amountOut Expected output amount
     */
    function getExpectedOutput(
        SwapParams calldata swapParams
    ) external view override returns (uint256 amountOut) {
        address[] memory path = _getPath(swapParams);
        uint256[] memory amounts = IPancakeRouter02(router).getAmountsOut(
            swapParams.amountIn,
            path
        );
        return amounts[amounts.length - 1];
    }

    /**
     * @notice Allows owner to withdraw stuck tokens
     */
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            payable(owner).transfer(amount);
        } else {
            IERC20(token).transfer(owner, amount);
        }
    }

    function setRouter(address _router, address _wbnb) external onlyOwner {
        require(_router != address(0), "PancakeSwapAdaptor: zero router");
        require(_wbnb != address(0), "PancakeSwapAdaptor: zero wbnb");
        router = _router;
        wbnb = _wbnb;
    }

    function _getPath(SwapParams calldata swapParams) internal view returns (address[] memory) {
        if (swapParams.path.length > 0) {
            return abi.decode(swapParams.path, (address[]));
        }
        address inToken = swapParams.tokenIn == address(0) ? wbnb : swapParams.tokenIn;
        address outToken = swapParams.tokenOut == address(0) ? wbnb : swapParams.tokenOut;
        address[] memory path = new address[](2);
        path[0] = inToken;
        path[1] = outToken;
        return path;
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPancakeRouter02 {
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}
