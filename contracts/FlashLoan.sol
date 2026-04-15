// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";

// ---------------------------------------------------------------------------
// DEX router interfaces
// ---------------------------------------------------------------------------

/// @notice Minimal Uniswap V2-compatible router.
///         Works with Uniswap V2, SushiSwap, and ShibaSwap — they all share
///         the same swapExactTokensForTokens ABI.
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Minimal Uniswap V3 SwapRouter interface (exactInputSingle only).
interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut);
}

// ---------------------------------------------------------------------------
// Main contract
// ---------------------------------------------------------------------------

/**
 * @title  FlashLoan
 * @notice Executes flash-loan-backed two-leg DEX arbitrage using Aave V3.
 *
 * Execution flow
 * ──────────────
 *  1. Owner calls requestFlashLoan(asset, amount, params).
 *  2. Aave pool sends `amount` of `asset` to this contract.
 *  3. executeOperation() is triggered by the pool:
 *     a. Swap asset → tokenOut on buyRouter  (the cheaper DEX).
 *     b. Swap tokenOut → asset on sellRouter (the more expensive DEX).
 *     c. Verify: received asset ≥ principal + premium + minProfit.
 *     d. Approve pool to pull back principal + premium.
 *  4. Profit remains in the contract; owner calls withdraw() to collect it.
 *
 * Params encoding (passed through requestFlashLoan → executeOperation)
 * ────────────────────────────────────────────────────────────────────
 *  abi.encode(
 *      address tokenOut,      // intermediate token for the two-leg swap
 *      uint8   buyDexType,    // DEX_V2 or DEX_V3
 *      address buyRouter,     // router for the buy leg
 *      uint24  buyFee,        // Uniswap V3 fee tier (ignored for V2)
 *      uint8   sellDexType,   // DEX_V2 or DEX_V3
 *      address sellRouter,    // router for the sell leg
 *      uint24  sellFee,       // Uniswap V3 fee tier (ignored for V2)
 *      uint256 minProfit      // minimum profit required, in asset units
 *  )
 */
contract FlashLoan is IFlashLoanSimpleReceiver {
    /// @notice DEX type: Uniswap V2 / SushiSwap / ShibaSwap
    uint8 public constant DEX_V2 = 0;
    /// @notice DEX type: Uniswap V3
    uint8 public constant DEX_V3 = 1;

    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool                  public immutable override POOL;

    address public owner;

    mapping(address => bool) public whitelist;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ArbitrageExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountBorrowed,
        uint256 profit
    );

    event WhitelistUpdated(address indexed account, bool allowed);

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyWhitelisted() {
        require(whitelist[msg.sender], "Not whitelisted");
        _;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param addressesProvider Aave V3 PoolAddressesProvider.
     *        Ethereum mainnet: 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9
     */
    constructor(address addressesProvider) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(addressesProvider);
        POOL = IPool(IPoolAddressesProvider(addressesProvider).getPool());
        owner = msg.sender;
        whitelist[msg.sender] = true;
    }

    // -----------------------------------------------------------------------
    // External — entry point
    // -----------------------------------------------------------------------

    /**
     * @notice Trigger a flash-loan-backed arbitrage.
     * @param asset  Token to borrow (= tokenIn for the arb).
     * @param amount Amount to borrow.
     * @param params ABI-encoded arb route (see struct description above).
     */
    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyWhitelisted {
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
    }

    // -----------------------------------------------------------------------
    // Owner — whitelist management
    // -----------------------------------------------------------------------

    /// @notice Add an address to the caller whitelist.
    function addToWhitelist(address account) external onlyOwner {
        require(account != address(0), "Zero address");
        whitelist[account] = true;
        emit WhitelistUpdated(account, true);
    }

    /// @notice Remove an address from the caller whitelist.
    function removeFromWhitelist(address account) external onlyOwner {
        whitelist[account] = false;
        emit WhitelistUpdated(account, false);
    }

    // -----------------------------------------------------------------------
    // IFlashLoanSimpleReceiver — callback
    // -----------------------------------------------------------------------

    /**
     * @dev Called by the Aave pool immediately after transferring funds.
     *      Performs the two-leg swap and repays the loan.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Caller must be POOL");
        require(initiator == address(this), "Only this contract can initiate");

        (
            address tokenOut,
            uint8   buyDexType,
            address buyRouter,
            uint24  buyFee,
            uint8   sellDexType,
            address sellRouter,
            uint24  sellFee,
            uint256 minProfit
        ) = abi.decode(
            params,
            (address, uint8, address, uint24, uint8, address, uint24, uint256)
        );

        // Leg 1 — buy tokenOut cheaply by spending asset
        uint256 amountOut = _swap(buyDexType, buyRouter, asset, tokenOut, amount, buyFee);

        // Leg 2 — sell tokenOut at a higher price, receiving asset back
        uint256 amountBack = _swap(sellDexType, sellRouter, tokenOut, asset, amountOut, sellFee);

        // Profitability check: must cover flash-loan premium + owner's minimum
        uint256 totalOwed = amount + premium;
        require(amountBack >= totalOwed + minProfit, "Arb not profitable");

        emit ArbitrageExecuted(asset, tokenOut, amount, amountBack - totalOwed);

        // Approve Aave to pull back principal + premium; profit stays here
        IERC20(asset).approve(address(POOL), totalOwed);
        return true;
    }

    // -----------------------------------------------------------------------
    // Owner — profit collection
    // -----------------------------------------------------------------------

    /// @notice Withdraw all of `token` held by this contract to the owner.
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        IERC20(token).transfer(owner, balance);
    }

    /// @notice Withdraw all ETH held by this contract to the owner.
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH balance");
        payable(owner).transfer(balance);
    }

    receive() external payable {}

    // -----------------------------------------------------------------------
    // Internal — swap helper
    // -----------------------------------------------------------------------

    /**
     * @dev Routes a single swap through either a V2-compatible or V3 router.
     *      Sets `amountOutMin = 1`; the profitability check in executeOperation
     *      is the real slippage guard.
     *
     * @param dexType  DEX_V2 or DEX_V3.
     * @param router   Router contract address.
     * @param tokenIn  Token to spend.
     * @param tokenOut Token to receive.
     * @param amountIn Exact amount of tokenIn.
     * @param fee      Uniswap V3 pool fee tier (e.g. 3000 = 0.3%); ignored for V2.
     * @return amountOut Amount of tokenOut received.
     */
    function _swap(
        uint8   dexType,
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  fee
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(router, amountIn);

        if (dexType == DEX_V2) {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;

            uint256[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
                amountIn,
                1,              // amountOutMin — real guard is the profit check
                path,
                address(this),
                block.timestamp
            );
            amountOut = amounts[amounts.length - 1];

        } else if (dexType == DEX_V3) {
            amountOut = IUniswapV3Router(router).exactInputSingle(
                IUniswapV3Router.ExactInputSingleParams({
                    tokenIn:           tokenIn,
                    tokenOut:          tokenOut,
                    fee:               fee,
                    recipient:         address(this),
                    deadline:          block.timestamp,
                    amountIn:          amountIn,
                    amountOutMinimum:  1,
                    sqrtPriceLimitX96: 0
                })
            );

        } else {
            revert("Unknown DEX type");
        }
    }
}
