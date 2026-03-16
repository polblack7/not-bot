// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// ---------------------------------------------------------------------------
// MockERC20
// ---------------------------------------------------------------------------

contract MockERC20 {
    string  public name;
    string  public symbol;
    uint8   public decimals;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name     = _name;
        symbol   = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        return true;
    }
}

// ---------------------------------------------------------------------------
// MockPoolAddressesProvider
// ---------------------------------------------------------------------------

contract MockPoolAddressesProvider {
    address private _pool;

    constructor(address pool) {
        _pool = pool;
    }

    function getPool() external view returns (address) {
        return _pool;
    }
}

// ---------------------------------------------------------------------------
// MockAavePool
// ---------------------------------------------------------------------------

interface IFlashLoanCallback {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @dev Simulates Aave V3 Pool.flashLoanSimple.
///      The pool must hold enough `asset` to lend out before the test calls it.
contract MockAavePool {
    /// @dev 0.05% flash-loan fee — matches Aave V3 mainnet default.
    uint256 public constant PREMIUM_BPS = 5;

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16  /* referralCode */
    ) external {
        // Transfer the loan to the receiver
        MockERC20(asset).transfer(receiver, amount);

        uint256 premium    = (amount * PREMIUM_BPS) / 10_000;
        uint256 totalOwed  = amount + premium;

        // Trigger the arbitrage callback; initiator == msg.sender == FlashLoan contract
        bool success = IFlashLoanCallback(receiver).executeOperation(
            asset,
            amount,
            premium,
            msg.sender,
            params
        );
        require(success, "executeOperation returned false");

        // Pull back principal + premium (receiver must have approved this contract)
        MockERC20(asset).transferFrom(receiver, address(this), totalOwed);
    }
}

// ---------------------------------------------------------------------------
// MockV2Router
// ---------------------------------------------------------------------------

/// @dev Simulates a Uniswap V2-compatible router with a fixed exchange rate:
///      amountOut = amountIn * numerator / denominator
contract MockV2Router {
    uint256 public numerator;
    uint256 public denominator;

    constructor(uint256 _numerator, uint256 _denominator) {
        numerator   = _numerator;
        denominator = _denominator;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        amounts    = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * numerator) / denominator;

        MockERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(path[1]).transfer(to, amounts[1]);
    }
}

// ---------------------------------------------------------------------------
// MockV3Router
// ---------------------------------------------------------------------------

/// @dev Simulates a Uniswap V3 SwapRouter with a fixed exchange rate.
contract MockV3Router {
    uint256 public numerator;
    uint256 public denominator;

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

    constructor(uint256 _numerator, uint256 _denominator) {
        numerator   = _numerator;
        denominator = _denominator;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        returns (uint256 amountOut)
    {
        amountOut = (p.amountIn * numerator) / denominator;
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        MockERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}
