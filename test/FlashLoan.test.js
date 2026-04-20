const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ─── constants ────────────────────────────────────────────────────────────────

const DEX_V2 = 0;
const DEX_V3 = 1;

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * ABI-encode the params blob that executeOperation() decodes.
 *
 * Layout (mirrors the Solidity abi.decode):
 *   (address tokenOut, uint8 buyDexType, address buyRouter, uint24 buyFee,
 *    uint8 sellDexType, address sellRouter, uint24 sellFee, uint256 minProfit)
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
 *  • buyRouter  (V2, rate 2×):   1 tokenA  →  2 tokenB   (cheap DEX)
 *  • sellRouter (V2, rate 55%):  2 tokenB  →  1.1 tokenA (expensive DEX)
 *  • Aave premium (0.05% = 5 bps): 0.0005 ether tokenA
 *  • Net profit ≈ 0.0995 ether tokenA  ✓
 */
async function deployFixture() {
  const [owner, attacker, alice] = await ethers.getSigners();

  // ── tokens ────────────────────────────────────────────────────────────────
  const TokenA = await ethers.getContractFactory("MockERC20");
  const tokenA = await TokenA.deploy("Token A", "TKNA", 18);
  const TokenB = await ethers.getContractFactory("MockERC20");
  const tokenB = await TokenB.deploy("Token B", "TKNB", 18);

  // ── Aave pool mock ────────────────────────────────────────────────────────
  const Pool = await ethers.getContractFactory("MockAavePool");
  const pool = await Pool.deploy();

  const POOL_RESERVE = ethers.parseEther("1000");
  await tokenA.mint(await pool.getAddress(), POOL_RESERVE);

  // ── PoolAddressesProvider mock ────────────────────────────────────────────
  const Provider = await ethers.getContractFactory("MockPoolAddressesProvider");
  const provider = await Provider.deploy(await pool.getAddress());

  // ── V2 routers ────────────────────────────────────────────────────────────
  //   buyRouter:  tokenA → tokenB at 2×         (numerator=2,  denominator=1)
  //   sellRouter: tokenB → tokenA at 55%        (numerator=55, denominator=100)
  const V2Router = await ethers.getContractFactory("MockV2Router");
  const buyRouterV2  = await V2Router.deploy(2,  1);
  const sellRouterV2 = await V2Router.deploy(55, 100);

  const ROUTER_RESERVE = ethers.parseEther("10000");
  await tokenB.mint(await buyRouterV2.getAddress(),  ROUTER_RESERVE);
  await tokenA.mint(await sellRouterV2.getAddress(), ROUTER_RESERVE);

  // ── V3 sell router (for the V2→V3 test) ─────────────────────────────────
  const V3Router = await ethers.getContractFactory("MockV3Router");
  const sellRouterV3 = await V3Router.deploy(55, 100);
  await tokenA.mint(await sellRouterV3.getAddress(), ROUTER_RESERVE);

  // ── FlashLoan contract ────────────────────────────────────────────────────
  const FlashLoan = await ethers.getContractFactory("FlashLoan");
  const flashLoan  = await FlashLoan.deploy(await provider.getAddress());

  // Approve all mock routers so existing arb paths work out of the box.
  await flashLoan.setRouterApproval(await buyRouterV2.getAddress(),  true);
  await flashLoan.setRouterApproval(await sellRouterV2.getAddress(), true);
  await flashLoan.setRouterApproval(await sellRouterV3.getAddress(), true);

  return {
    owner,
    attacker,
    alice,
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
      const { flashLoan, provider } = await loadFixture(deployFixture);
      expect(await flashLoan.ADDRESSES_PROVIDER()).to.equal(await provider.getAddress());
    });

    it("sets POOL to the mock pool (resolved from provider)", async function () {
      const { flashLoan, pool } = await loadFixture(deployFixture);
      expect(await flashLoan.POOL()).to.equal(await pool.getAddress());
    });

    it("sets owner to deployer", async function () {
      const { flashLoan, owner } = await loadFixture(deployFixture);
      expect(await flashLoan.owner()).to.equal(owner.address);
    });

    it("exposes correct DEX type constants", async function () {
      const { flashLoan } = await loadFixture(deployFixture);
      expect(await flashLoan.DEX_V2()).to.equal(DEX_V2);
      expect(await flashLoan.DEX_V3()).to.equal(DEX_V3);
    });

    it("auto-whitelists the deployer (owner)", async function () {
      const { flashLoan, owner } = await loadFixture(deployFixture);
      expect(await flashLoan.whitelist(owner.address)).to.be.true;
    });
  });

  // ── access control ─────────────────────────────────────────────────────────

  describe("Access control", function () {
    it("reverts requestFlashLoan for non-whitelisted callers", async function () {
      const { flashLoan, attacker, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

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
      ).to.be.revertedWith("Not whitelisted");
    });

    it("allows a whitelisted non-owner to call requestFlashLoan", async function () {
      const { flashLoan, alice, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

      // Owner adds alice to the whitelist
      await flashLoan.addToWhitelist(alice.address);
      expect(await flashLoan.whitelist(alice.address)).to.be.true;

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.connect(alice).requestFlashLoan(
          await tokenA.getAddress(),
          ethers.parseEther("1"),
          params
        )
      ).to.emit(flashLoan, "ArbitrageExecuted");
    });

    it("reverts addToWhitelist when called by non-owner", async function () {
      const { flashLoan, attacker, alice } = await loadFixture(deployFixture);
      await expect(
        flashLoan.connect(attacker).addToWhitelist(alice.address)
      )
        .to.be.revertedWithCustomError(flashLoan, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
    });

    it("reverts addToWhitelist for zero address", async function () {
      const { flashLoan } = await loadFixture(deployFixture);
      await expect(
        flashLoan.addToWhitelist(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });

    it("reverts removeFromWhitelist when called by non-owner", async function () {
      const { flashLoan, attacker, owner } = await loadFixture(deployFixture);
      await expect(
        flashLoan.connect(attacker).removeFromWhitelist(owner.address)
      )
        .to.be.revertedWithCustomError(flashLoan, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
    });

    it("removes an address from the whitelist", async function () {
      const { flashLoan, owner } = await loadFixture(deployFixture);
      await flashLoan.removeFromWhitelist(owner.address);
      expect(await flashLoan.whitelist(owner.address)).to.be.false;
    });

    it("emits WhitelistUpdated on add and remove", async function () {
      const { flashLoan, alice } = await loadFixture(deployFixture);

      await expect(flashLoan.addToWhitelist(alice.address))
        .to.emit(flashLoan, "WhitelistUpdated")
        .withArgs(alice.address, true);

      await expect(flashLoan.removeFromWhitelist(alice.address))
        .to.emit(flashLoan, "WhitelistUpdated")
        .withArgs(alice.address, false);
    });

    it("reverts executeOperation when caller is not the pool", async function () {
      const { flashLoan, attacker, tokenA } = await loadFixture(deployFixture);

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
        await loadFixture(deployFixture);

      const BORROW        = ethers.parseEther("1");
      // premium = 1e18 * 5 / 10000 = 5e14
      const PREMIUM       = (BORROW * 5n) / 10_000n;
      const TOTAL_OWED    = BORROW + PREMIUM;
      // amountOut after buy:  1e18 * 2       = 2e18  tokenB
      // amountBack after sell: 2e18 * 55/100 = 1.1e18 tokenA
      const AMOUNT_BACK   = (BORROW * 2n * 55n) / 100n;
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
        await loadFixture(deployFixture);

      const BORROW  = ethers.parseEther("1");

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V3, await sellRouterV3.getAddress(), 3000,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params)
      ).to.emit(flashLoan, "ArbitrageExecuted");

      // Contract should hold a positive tokenA balance (profit)
      const profit = await tokenA.balanceOf(await flashLoan.getAddress());
      expect(profit).to.be.gt(0n);
    });
  });

  // ── profit guard ────────────────────────────────────────────────────────────

  describe("Profit guard", function () {
    it("reverts when the spread does not cover the flash-loan premium", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2 } =
        await loadFixture(deployFixture);

      // Deploy a sell router that returns only 45% — insufficient to cover premium
      const BadSell = await ethers.getContractFactory("MockV2Router");
      const badSellRouter = await BadSell.deploy(45, 100);
      await tokenA.mint(await badSellRouter.getAddress(), ethers.parseEther("10000"));
      await flashLoan.setRouterApproval(await badSellRouter.getAddress(), true);

      const BORROW = ethers.parseEther("1");
      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),   0,
        DEX_V2, await badSellRouter.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), BORROW, params)
      ).to.be.revertedWith("Arb not profitable");
    });

    it("reverts when profit is below the owner-specified minProfit", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

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
    it("owner can withdraw ERC-20 profit after a successful arb", async function () {
      const { flashLoan, owner, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

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

      expect(await tokenA.balanceOf(await flashLoan.getAddress())).to.equal(0n);
    });

    it("reverts withdraw when there is no balance", async function () {
      const { flashLoan, tokenA } = await loadFixture(deployFixture);
      await expect(
        flashLoan.withdraw(await tokenA.getAddress())
      ).to.be.revertedWith("No balance");
    });

    it("reverts withdraw when called by non-owner", async function () {
      const { flashLoan, attacker, tokenA } = await loadFixture(deployFixture);
      await expect(
        flashLoan.connect(attacker).withdraw(await tokenA.getAddress())
      )
        .to.be.revertedWithCustomError(flashLoan, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
    });
  });

  // ── router whitelist ───────────────────────────────────────────────────────

  describe("Router whitelist", function () {
    it("reverts executeOperation when buyRouter is not approved", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

      await flashLoan.setRouterApproval(await buyRouterV2.getAddress(), false);

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(
          await tokenA.getAddress(), ethers.parseEther("1"), params
        )
      ).to.be.revertedWith("Buy router not approved");
    });

    it("reverts setRouterApproval for non-owner", async function () {
      const { flashLoan, attacker, buyRouterV2 } = await loadFixture(deployFixture);
      await expect(
        flashLoan.connect(attacker).setRouterApproval(await buyRouterV2.getAddress(), true)
      )
        .to.be.revertedWithCustomError(flashLoan, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
    });

    it("emits RouterApprovalUpdated", async function () {
      const { flashLoan, buyRouterV2 } = await loadFixture(deployFixture);
      await expect(flashLoan.setRouterApproval(await buyRouterV2.getAddress(), false))
        .to.emit(flashLoan, "RouterApprovalUpdated")
        .withArgs(await buyRouterV2.getAddress(), false);
    });
  });

  // ── ownership transfer (Ownable2Step) ──────────────────────────────────────

  describe("Ownership (2-step)", function () {
    it("transfer is 2-step: pending then accepted", async function () {
      const { flashLoan, owner, alice } = await loadFixture(deployFixture);

      await flashLoan.transferOwnership(alice.address);
      // Owner hasn't changed yet
      expect(await flashLoan.owner()).to.equal(owner.address);
      expect(await flashLoan.pendingOwner()).to.equal(alice.address);

      await flashLoan.connect(alice).acceptOwnership();
      expect(await flashLoan.owner()).to.equal(alice.address);
    });

    it("only pending owner can accept", async function () {
      const { flashLoan, attacker, alice } = await loadFixture(deployFixture);
      await flashLoan.transferOwnership(alice.address);
      await expect(flashLoan.connect(attacker).acceptOwnership())
        .to.be.revertedWithCustomError(flashLoan, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
    });
  });

  // ── ETH withdrawal ─────────────────────────────────────────────────────────

  describe("ETH withdrawal", function () {
    it("owner can withdraw ETH sent to the contract", async function () {
      const { flashLoan, owner, alice } = await loadFixture(deployFixture);
      const AMOUNT = ethers.parseEther("0.5");

      await alice.sendTransaction({ to: await flashLoan.getAddress(), value: AMOUNT });
      expect(await ethers.provider.getBalance(await flashLoan.getAddress())).to.equal(AMOUNT);

      await expect(flashLoan.withdrawETH())
        .to.changeEtherBalances([flashLoan, owner], [-AMOUNT, AMOUNT]);
    });

    it("reverts withdrawETH when balance is zero", async function () {
      const { flashLoan } = await loadFixture(deployFixture);
      await expect(flashLoan.withdrawETH()).to.be.revertedWith("No ETH balance");
    });
  });

  // ── pause ──────────────────────────────────────────────────────────────────

  describe("Pause", function () {
    it("owner can pause and unpause", async function () {
      const { flashLoan } = await loadFixture(deployFixture);
      expect(await flashLoan.paused()).to.be.false;
      await flashLoan.pause();
      expect(await flashLoan.paused()).to.be.true;
      await flashLoan.unpause();
      expect(await flashLoan.paused()).to.be.false;
    });

    it("reverts requestFlashLoan when paused", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

      await flashLoan.pause();

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(), 0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), ethers.parseEther("1"), params)
      ).to.be.revertedWithCustomError(flashLoan, "EnforcedPause");
    });

    it("reverts pause when called by non-owner", async function () {
      const { flashLoan, attacker } = await loadFixture(deployFixture);
      await expect(flashLoan.connect(attacker).pause())
        .to.be.revertedWithCustomError(flashLoan, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
    });

    it("arb executes normally after unpause", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

      await flashLoan.pause();
      await flashLoan.unpause();

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(), 0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      await expect(
        flashLoan.requestFlashLoan(await tokenA.getAddress(), ethers.parseEther("1"), params)
      ).to.emit(flashLoan, "ArbitrageExecuted");
    });
  });

  // ── event ──────────────────────────────────────────────────────────────────

  describe("Event", function () {
    it("ArbitrageExecuted emitted with correct tokenIn, tokenOut, amountBorrowed, profit", async function () {
      const { flashLoan, tokenA, tokenB, buyRouterV2, sellRouterV2 } =
        await loadFixture(deployFixture);

      const BORROW        = ethers.parseEther("1");
      const PREMIUM       = (BORROW * 5n) / 10_000n;
      const TOTAL_OWED    = BORROW + PREMIUM;
      const AMOUNT_BACK   = (BORROW * 2n * 55n) / 100n;
      const EXPECTED_PROFIT = AMOUNT_BACK - TOTAL_OWED;

      const params = encodeParams(
        await tokenB.getAddress(),
        DEX_V2, await buyRouterV2.getAddress(),  0,
        DEX_V2, await sellRouterV2.getAddress(), 0,
        0n
      );

      const tx = await flashLoan.requestFlashLoan(
        await tokenA.getAddress(), BORROW, params
      );
      const receipt = await tx.wait();

      const iface  = flashLoan.interface;
      const evtLog = receipt.logs.find(
        (l) => l.topics[0] === iface.getEvent("ArbitrageExecuted").topicHash
      );
      expect(evtLog).to.not.be.undefined;

      const parsed = iface.parseLog(evtLog);
      expect(parsed.args.tokenIn).to.equal(await tokenA.getAddress());
      expect(parsed.args.tokenOut).to.equal(await tokenB.getAddress());
      expect(parsed.args.amountBorrowed).to.equal(BORROW);
      expect(parsed.args.profit).to.equal(EXPECTED_PROFIT);
    });
  });
});
