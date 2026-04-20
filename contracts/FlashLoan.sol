// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
contract FlashLoan is IFlashLoanSimpleReceiver, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20OZ;

    /// @notice DEX type: Uniswap V2 / SushiSwap / ShibaSwap
    uint8 public constant DEX_V2 = 0;
    /// @notice DEX type: Uniswap V3
    uint8 public constant DEX_V3 = 1;

    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;

    mapping(address => bool) public whitelist;
    mapping(address => bool) public approvedRouters;

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
    event RouterApprovalUpdated(address indexed router, bool approved);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event WithdrawnETH(address indexed to, uint256 amount);

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyWhitelisted() {
        require(whitelist[msg.sender], "Not whitelisted");
        _;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param addressesProvider Aave V3 PoolAddressesProvider.
     *        Ethereum mainnet: 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
     */
    constructor(address addressesProvider) Ownable(msg.sender) {
        require(addressesProvider != address(0), "Zero provider");
        ADDRESSES_PROVIDER = IPoolAddressesProvider(addressesProvider);
        whitelist[msg.sender] = true;
        emit WhitelistUpdated(msg.sender, true);
    }

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------

    /// @notice Current Aave pool. Resolved dynamically to honor upgrades
    ///         performed via PoolAddressesProvider.
    function POOL() public view override returns (IPool) {
        return IPool(ADDRESSES_PROVIDER.getPool());
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
    /// @notice Pause all arbitrage execution. Used when migrating to a new contract.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume arbitrage execution.
    function unpause() external onlyOwner {
        _unpause();
    }

    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyWhitelisted nonReentrant whenNotPaused {
        POOL().flashLoanSimple(address(this), asset, amount, params, 0);
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

    /// @notice Approve a DEX router address. Only approved routers can be
    ///         used in arbitrage params — guards against a compromised
    ///         whitelisted key routing through a malicious contract.
    function setRouterApproval(address router, bool approved) external onlyOwner {
        require(router != address(0), "Zero address");
        approvedRouters[router] = approved;
        emit RouterApprovalUpdated(router, approved);
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
        IPool pool = POOL();
        require(msg.sender == address(pool), "Caller must be POOL");
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

        require(approvedRouters[buyRouter],  "Buy router not approved");
        require(approvedRouters[sellRouter], "Sell router not approved");

        // Leg 1 — buy tokenOut cheaply by spending asset
        uint256 amountOut = _swap(buyDexType, buyRouter, asset, tokenOut, amount, buyFee);

        // Leg 2 — sell tokenOut at a higher price, receiving asset back
        uint256 amountBack = _swap(sellDexType, sellRouter, tokenOut, asset, amountOut, sellFee);

        // Profitability check: must cover flash-loan premium + owner's minimum
        uint256 totalOwed = amount + premium;
        require(amountBack >= totalOwed + minProfit, "Arb not profitable");

        emit ArbitrageExecuted(asset, tokenOut, amount, amountBack - totalOwed);

        // Approve Aave to pull back principal + premium; profit stays here
        IERC20OZ(asset).forceApprove(address(pool), totalOwed);
        return true;
    }

    // -----------------------------------------------------------------------
    // Owner — profit collection
    // -----------------------------------------------------------------------

    /// @notice Withdraw all of `token` held by this contract to the owner.
    function withdraw(address token) external onlyOwner nonReentrant {
        uint256 balance = IERC20OZ(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        IERC20OZ(token).safeTransfer(owner(), balance);
        emit Withdrawn(token, owner(), balance);
    }

    /// @notice Withdraw all ETH held by this contract to the owner.
    function withdrawETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH balance");
        (bool ok, ) = payable(owner()).call{value: balance}("");
        require(ok, "ETH transfer failed");
        emit WithdrawnETH(owner(), balance);
    }

    receive() external payable {}

    // -----------------------------------------------------------------------
    // Internal — swap helper
    // -----------------------------------------------------------------------

    /**
     * @dev Routes a single swap through either a V2-compatible or V3 router.
     *      Uses the caller-supplied `minProfit` check in executeOperation as
     *      the real slippage guard, so per-hop amountOutMin is set to 1.
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
        IERC20OZ(tokenIn).forceApprove(router, amountIn);

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