# FlashLoan Arbitrage — Developer Guide

## Overview

`FlashLoan.sol` borrows a token from Aave V3, executes a two-leg DEX swap
(buy cheap → sell expensive), repays the loan, and keeps the spread as profit.
All of this happens atomically in a single transaction — if any step fails the
whole transaction reverts and no funds are lost.

```
Owner
  │
  ▼
requestFlashLoan(asset, amount, params)
  │
  ▼
Aave Pool ──► sends `amount` of `asset` to FlashLoan contract
  │
  ▼
executeOperation() [called by pool]
  ├── Leg 1: swap asset → tokenOut  on buyRouter  (cheap DEX)
  ├── Leg 2: swap tokenOut → asset  on sellRouter (expensive DEX)
  ├── Assert: received ≥ principal + premium + minProfit
  └── Approve pool to pull back principal + premium
  │
  ▼
Profit stays in the contract → owner calls withdraw()
```

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 18 |
| npm | ≥ 9 |

```bash
cd not-bot
npm install
```

---

## Running the Tests (no wallet, no RPC needed)

The test suite uses mock contracts — no Ethereum node or real funds required.

```bash
npx hardhat test test/FlashLoan.js
```

Expected output: **13 passing**.

To see gas usage alongside the results:

```bash
REPORT_GAS=true npx hardhat test test/FlashLoan.js
```

### What the tests cover

| Suite | Tests |
|---|---|
| Deployment | ADDRESSES_PROVIDER, POOL, owner, DEX constants |
| Access control | Non-owner `requestFlashLoan` reverts; direct `executeOperation` call reverts |
| Successful arbitrage | V2→V2 arb retains correct profit; V2→V3 arb works; owner can withdraw |
| Profit guard | Insufficient spread reverts; `minProfit` threshold not met reverts |
| Withdrawal | Zero-balance reverts; non-owner reverts |

---

## Compiling

```bash
npx hardhat compile
```

The compiler uses `viaIR: true` + optimizer (200 runs) to handle the stack
depth of `executeOperation`. Artifacts land in `artifacts/`.

---

## Environment Variables (for deployment)

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `INFURA_GOERLI_ENDPOINT` | Goerli RPC URL (e.g. `https://goerli.infura.io/v3/<key>`) |
| `PRIVATE_KEY` | Deployer's private key (no `0x` prefix required by dotenv) |

If either variable is missing the Goerli network is simply omitted from the
config — local tests still work.

---

## Deploying to Goerli (testnet)

> You need Goerli ETH in your wallet. Get some from a faucet before deploying.

### 1. Write a deploy script

Create `scripts/deployFlashLoan.js`:

```js
const { ethers } = require("hardhat");

async function main() {
  // Aave V3 PoolAddressesProvider — Goerli testnet
  const ADDRESSES_PROVIDER = "0xc4dCB5126a895f1CE5e15f4B13b55E5B19c888b9";

  const FlashLoan = await ethers.getContractFactory("FlashLoan");
  const flashLoan = await FlashLoan.deploy(ADDRESSES_PROVIDER);
  await flashLoan.waitForDeployment();

  console.log("FlashLoan deployed to:", await flashLoan.getAddress());
}

main().catch((err) => { console.error(err); process.exit(1); });
```

### 2. Deploy

```bash
npx hardhat run scripts/deployFlashLoan.js --network goerli
```

Save the printed contract address — you'll need it for every interaction.

---

## Calling `requestFlashLoan` (triggering an arb)

### Encoding `params`

The `params` argument is an ABI-encoded blob that tells `executeOperation`
which tokens and routers to use:

```
abi.encode(
  address tokenOut,      // intermediate token (e.g. WETH)
  uint8   buyDexType,    // 0 = V2-compatible, 1 = V3
  address buyRouter,     // router for the buy leg
  uint24  buyFee,        // Uniswap V3 fee tier (3000 = 0.3%); ignored for V2
  uint8   sellDexType,
  address sellRouter,
  uint24  sellFee,
  uint256 minProfit      // revert if net profit < this (in asset units)
)
```

### Example: USDC → WETH arb via Uniswap V3 (buy) and SushiSwap (sell)

```js
const { ethers } = require("hardhat");

// Mainnet addresses
const FLASH_LOAN = "0x<your deployed contract>";
const USDC       = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH       = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const UNI_V3_ROUTER  = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SUSHI_ROUTER   = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const DEX_V2 = 0;
const DEX_V3 = 1;

const params = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address","uint8","address","uint24","uint8","address","uint24","uint256"],
  [
    WETH,
    DEX_V3, UNI_V3_ROUTER,  3000,   // buy WETH cheaply on Uniswap V3 (0.3% pool)
    DEX_V2, SUSHI_ROUTER,   0,      // sell WETH at a higher price on SushiSwap
    0n,                             // minProfit = 0 (accept any profit)
  ]
);

const flashLoan = await ethers.getContractAt("FlashLoan", FLASH_LOAN);
const BORROW_AMOUNT = ethers.parseUnits("10000", 6); // 10 000 USDC

const tx = await flashLoan.requestFlashLoan(USDC, BORROW_AMOUNT, params);
await tx.wait();
console.log("Arb executed:", tx.hash);
```

### Supported DEX router addresses (Ethereum mainnet)

| DEX | Type | Router address |
|---|---|---|
| Uniswap V2 | V2 | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` |
| Uniswap V3 | V3 | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| SushiSwap | V2 | `0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F` |
| ShibaSwap | V2 | `0x03f7724180AA6b939894B5Ca4314783B0b36b329` |

---

## Withdrawing Profit

After a successful arbitrage the profit stays in the contract.

```js
// Withdraw an ERC-20 token
await flashLoan.withdraw(USDC_ADDRESS);

// Withdraw ETH (if any landed in the contract)
await flashLoan.withdrawETH();
```

Only the `owner` (the deployer) can call these.

---

## Integration with the DEX Monitor

The Python DEX monitor (`not-dex-monitor/`) detects price discrepancies and
emits `opportunity` events with `buy_dex`, `sell_dex`, and `expected_profit_pct`.
To wire the monitor to this contract:

1. Map each DEX name to its router address and type (V2 / V3).
2. In the event handler, encode `params` and call `requestFlashLoan`.
3. Use `minProfit` to enforce a floor (e.g. enough to cover gas).

```python
# Pseudo-code — adapt to your off-chain executor
DEX_ROUTERS = {
    "Uniswap V2":  ("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", 0, 0),
    "Uniswap V3":  ("0xE592427A0AEce92De3Edee1F18E0157C05861564", 1, 3000),
    "SushiSwap":   ("0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", 0, 0),
    "ShibaSwap":   ("0x03f7724180AA6b939894B5Ca4314783B0b36b329", 0, 0),
}

def on_opportunity(event):
    buy_router, buy_type, buy_fee   = DEX_ROUTERS[event["buy_dex"]]
    sell_router, sell_type, sell_fee = DEX_ROUTERS[event["sell_dex"]]

    params = abi_encode(
        token_out, buy_type, buy_router, buy_fee,
        sell_type, sell_router, sell_fee,
        min_profit_wei,
    )
    flash_loan_contract.requestFlashLoan(asset, borrow_amount, params)
```

---

## Key Aave V3 Addresses

| Network | PoolAddressesProvider |
|---|---|
| Ethereum mainnet | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9` |
| Goerli testnet | `0xc4dCB5126a895f1CE5e15f4B13b55E5B19c888b9` |

> **Note:** Aave V3 flash loan fee is **0.05%** of the borrowed amount.
> Your spread must exceed this fee plus gas costs to be profitable.
