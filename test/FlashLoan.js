const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ─── helpers ──────────────────────────────────────────────────────────────────

const DEX_V2 = 0;
const DEX_V3 = 1;

/**
 * ABI-encode the params blob that executeOperation() decodes.
 *
 * @param {string}  tokenOut    address of the intermediate token
 * @param {number}  buyDexType  DEX_V2 | DEX_V3
 * @param {string}  buyRouter   address of the buy-leg router
 * @param {number}  buyFee      Uniswap V3 fee tier (ignored for V2)
 * @param {number}  sellDexType DEX_V2 | DEX_V3
 * @param {string}  sellRouter  address of the sell-leg router
 * @param {number}  sellFee     Uniswap V3 fee tier (ignored for V2)
 * @param {bigint}  minProfit   minimum acceptable profit (in asset units)
 */
function encodeParams(
  tokenOut,
  buyDexType,  buyRouter,  buyFee,
  sellDexType, sellRouter, sellFee,
  minProfit
) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint8", "address", "uint24", "uint8", "address", "uint24", "uint256"],
    [tokenOut, buyDexType, buyRouter, buyFee, sellDexType, sellRouter, sellFee, minProfit]
  );
}

// ─── fixture ──────────────────────────────────────────────────────────────────

/**
 * Deploy the full mock stack and the FlashLoan contract.
 *
 * Arbitrage scenario
 * ──────────────────
 *  • Borrow 1 ether of tokenA from Aave (flash loan).
 *  • buyRouter  (V2, rate 2×): 1 tokenA  → 2 tokenB   (cheap DEX)
 *  • sellRouter (V2, rate 55%): 2 tokenB → 1.1 tokenA  (expensive DEX)
 *  • Aave premium (0.05%): 0.0005 ether of tokenA
 *  • Net profit ≈ 0.0995 ether of tokenA  ✓
 */
async function deployFixture() {
  const [owner, attacker] = await ethers.getSigners();

  // ── tokens ────────────────────────────────────────────────────────────────
  const TokenA = await ethers.getContractFactory("MockERC20");
  const tokenA = await TokenA.deploy("Token A", "TKNA", 18);
  const TokenB = await ethers.getContractFactory("MockERC20");
  const tokenB = await TokenB.deploy("Token B", "TKNB", 18);

  // ── Aave pool mock ────────────────────────────────────────────────────────
  const Pool = await ethers.getContractFactory("MockAavePool");
  const pool = await Pool.deploy();

  // Fund the pool with tokenA so it can lend
  const POOL_RESERVE = ethers.parseEther("1000");
  await tokenA.mint(await pool.getAddress(), POOL_RESERVE);

  // ── PoolAddressesProvider mock ────────────────────────────────────────────
  const Provider = await ethers.getContractFactory("MockPoolAddressesProvider");
  const provider = await Provider.deploy(await pool.getAddress());

  // ── routers ───────────────────────────────────────────────────────────────
  //   buyRouter:  tokenA → tokenB at 2× (numerator=2, denominator=1)
  //   sellRouter: tokenB → tokenA at 55% (numerator=55, denominator=100)
  const V2Router = await ethers.getContractFactory("MockV2Router");
  const buyRouterV2  = await V2Router.deploy(2, 1);     // out = in * 2
  const sellRouterV2 = await V2Router.deploy(55, 100);  // out = in * 0.55

  // Fund routers with the token they must pay out
  const ROUTER_RESERVE = ethers.parseEther("10000");
  await tokenB.mint(await buyRouterV2.getAddress(),  ROUTER_RESERVE);
  await tokenA.mint(await sellRouterV2.getAddress(), ROUTER_RESERVE);

  // ── V3 sell router (for the V2→V3 test) ─────────────────────────────────
  const V3Router = await ethers.getContractFactory("MockV3Router");
  const sellRouterV3 = await V3Router.deploy(55, 100); // same 55% rate
  await tokenA.mint(await sellRouterV3.getAddress(), ROUTER_RESERVE);

  // ── FlashLoan contract ────────────────────────────────────────────────────
  const FlashLoan = await ethers.getContractFactory("FlashLoan");
  const flashLoan = await FlashLoan.deploy(await provider.getAddress());

  return {
    owner,
    attacker,
    tokenA,
    tokenB,
    pool,
    provider,
    buyRouterV2,
    sellRouterV2,
    sellRouterV3,
    flashLoan,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("FlashLoan — arbitrage", function () {

  // ── deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets ADDRESSES_PROVIDER to the mock provider", async function () {
      const { flashLoan, provider } = await deployFixture();
      expect(await flashLoan.ADDRESSES_PROVIDER()).to.equal(await provider.getAddress());
    });

    it("sets POOL to the mock pool (resolved from provider)", async function () {
      const { flashLoan, pool } = await deployFixture();
      expect(await flashLoan.POOL()).to.equal(await pool.getAddress());
    });

    it("sets owner to deployer", async function () {
      const { flashLoan, owner } = await deployFixture();
      expect(await flashLoan.owner()).to.equal(owner.address);
    });

    it("exposes correct DEX type constants", async function () {
      const { flashLoan } = await deployFixture();
      expect(await flashLoan.DEX_V2()).to.equal(0);
      expect(await flashLoan.DEX_V3()).to.equal(1);
    });
  });

  // ── access control ─────────────────────────────────────────────────────────

  describe("Access control", function () {
    it("reverts requestFlashLoan when called by non-owner", async function () {
      const { flashLoan, attacker, tokenA, buyRouterV2, sellRouterV2, tokenB } =
        await deployFixture();

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.connect(attacker).requestFlashLoan(
          await tokenA.getAddress(),
          ethers.parseEther("1"),
          params
        )
      ).to.be.revertedWith("Not owner");
    });

    it("reverts executeOperation when caller is not the pool", async function () {
      const { flashLoan, attacker, tokenA, tokenB } = await deployFixture();

      await expect(
        flashLoan.connect(attacker).executeOperation(
          await tokenA.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("0.0005"),
          await flashLoan.getAddress(),
          "0x"
        )
      ).to.be.revertedWith("Caller must be POOL");
    });
  });

  // ── successful arbitrage ────────────────────────────────────────────────────

  describe("Successful arbitrage", function () {
    it("executes V2→V2 arb and retains profit in the contract", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await deployFixture();

      const BORROW     = ethers.parseEther("1");
      // premium = 1e18 * 5 / 10000 = 5e14
      const PREMIUM    = (BORROW * 5n) / 10_000n;
      const TOTAL_OWED = BORROW + PREMIUM;
      // amountOut after buy: 1e18 * 2 = 2e18 tokenB
      // amountBack after sell: 2e18 * 55 / 100 = 1.1e18 tokenA
      const AMOUNT_BACK = (BORROW * 2n * 55n) / 100n;
      const EXPECTED_PROFIT = AMOUNT_BACK - TOTAL_OWED;

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params)
      )
        .to.emit(flashLoan, "ArbitrageExecuted")
        .withArgs(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          BORROW,
          EXPECTED_PROFIT
        );

      // Profit stays in the FlashLoan contract
      expect(await tokenA.balanceOf(await flashLoan.getAddress()))
        .to.equal(EXPECTED_PROFIT);
    });

    it("executes V2→V3 arb (buy on V2, sell on V3)", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV3 } =
        await deployFixture();

      const BORROW  = ethers.parseEther("1");
      const PREMIUM = (BORROW * 5n) / 10_000n;

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V3, await sellRouterV3.getAddress(), 3000,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params)
      ).to.emit(flashLoan, "ArbitrageExecuted");

      // Contract should hold a positive tokenA balance
      const profit = await tokenA.balanceOf(await flashLoan.getAddress());
      expect(profit).to.be.gt(0n);
    });

    it("owner can withdraw the profit after a successful arb", async function () {
      const { flashLoan, owner, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await deployFixture();

      const BORROW = ethers.parseEther("1");
      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params);

      const contractBalance = await tokenA.balanceOf(await flashLoan.getAddress());
      expect(contractBalance).to.be.gt(0n);

      await expect(flashLoan.withdraw(await tokenA.getAddress()))
        .to.changeTokenBalance(tokenA, owner, contractBalance);

      // Contract is empty after withdrawal
      expect(await tokenA.balanceOf(await flashLoan.getAddress())).to.equal(0n);
    });
  });

  // ── profit guard ────────────────────────────────────────────────────────────

  describe("Profit guard", function () {
    it("reverts when the spread does not cover the flash-loan premium", async function () {
      const { flashLoan, tokenA, tokenB, pool, buyRouterV2 } =
        await deployFixture();

      // Deploy a sell router that gives only 45% back — not enough to repay
      const BadSell = await ethers.getContractFactory("MockV2Router");
      const badSellRouter = await BadSell.deploy(45, 100); // out = in * 0.45
      await tokenA.mint(await badSellRouter.getAddress(), ethers.parseEther("10000"));

      const BORROW = ethers.parseEther("1");
      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await badSellRouter.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params)
      ).to.be.revertedWith("Arb not profitable");
    });

    it("reverts when profit is below the owner-specified minProfit", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await deployFixture();

      const BORROW = ethers.parseEther("1");
      // Actual profit ≈ 0.0995 ether; demand more than that
      const HUGE_MIN_PROFIT = ethers.parseEther("1");

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        HUGE_MIN_PROFIT
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params)
      ).to.be.revertedWith("Arb not profitable");
    });
  });

  // ── withdrawal ─────────────────────────────────────────────────────────────

  describe("Withdrawal", function () {
    it("reverts withdraw when there is no balance", async function () {
      const { flashLoan, tokenA } = await deployFixture();
      await expect(
        flashLoan.withdraw(await tokenA.getAddress())
      ).to.be.revertedWith("No balance");
    });

    it("reverts withdraw when called by non-owner", async function () {
      const { flashLoan, attacker, tokenA } = await deployFixture();
      await expect(
        flashLoan.connect(attacker).withdraw(await tokenA.getAddress())
      ).to.be.revertedWith("Not owner");
    });
  });
});
