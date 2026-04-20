/**
 * verify-deploy.js
 *
 * Two-phase check:
 *   1. PRE-DEPLOY  — confirms the local artifact has all expected functions/events.
 *   2. POST-DEPLOY — confirms the on-chain bytecode matches the artifact and that
 *                    every expected function is callable (owner, paused, etc.)
 *
 * Usage:
 *   Pre-deploy only:
 *     npx hardhat run scripts/verify-deploy.js --network mainnet
 *
 *   Post-deploy (pass contract address via env):
 *     DEPLOYED_ADDRESS=0x... npx hardhat run scripts/verify-deploy.js --network mainnet
 */

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

// ─── expected surface ────────────────────────────────────────────────────────

const EXPECTED_FUNCTIONS = [
  "pause",
  "unpause",
  "paused",
  "requestFlashLoan",
  "executeOperation",
  "addToWhitelist",
  "removeFromWhitelist",
  "setRouterApproval",
  "withdraw",
  "withdrawETH",
  "transferOwnership",
  "acceptOwnership",
  "pendingOwner",
  "owner",
  "whitelist",
  "approvedRouters",
  "POOL",
  "ADDRESSES_PROVIDER",
];

const EXPECTED_EVENTS = [
  "ArbitrageExecuted",
  "WhitelistUpdated",
  "RouterApprovalUpdated",
  "Withdrawn",
  "WithdrawnETH",
  "Paused",
  "Unpaused",
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function pass(msg) { console.log("  ✔", msg); }
function fail(msg) { console.error("  ✘", msg); process.exitCode = 1; }
function check(condition, msg) { condition ? pass(msg) : fail(msg); }

// ─── phase 1: artifact checks ─────────────────────────────────────────────────

async function checkArtifact() {
  console.log("\n── Phase 1: local artifact ─────────────────────────────────────");

  const artifactPath = path.join(
    __dirname, "..", "artifacts", "contracts", "FlashLoan.sol", "FlashLoan.json"
  );
  check(fs.existsSync(artifactPath), `artifact exists at ${artifactPath}`);
  if (!fs.existsSync(artifactPath)) return null;

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiNames = artifact.abi.map(e => e.name);

  for (const fn of EXPECTED_FUNCTIONS) {
    check(abiNames.includes(fn), `ABI has function/view: ${fn}`);
  }
  for (const ev of EXPECTED_EVENTS) {
    check(abiNames.includes(ev), `ABI has event: ${ev}`);
  }

  const bytecodeSizeKb = (artifact.deployedBytecode.length - 2) / 2 / 1024;
  check(bytecodeSizeKb < 24, `deployedBytecode < 24 KB (${bytecodeSizeKb.toFixed(1)} KB)`);

  console.log(`\n  bytecode size : ${((artifact.deployedBytecode.length - 2) / 2)} bytes`);
  return artifact;
}

// ─── phase 2: on-chain checks ─────────────────────────────────────────────────

async function checkOnChain(artifact, address) {
  console.log(`\n── Phase 2: on-chain at ${address} ─────────────────────────────`);

  const provider = hre.ethers.provider;

  // bytecode match
  const onChainCode  = await provider.getCode(address);
  const artifactCode = artifact.deployedBytecode;
  check(onChainCode !== "0x", "contract exists on-chain");
  const bytecodeMatch = onChainCode === artifactCode;
  check(bytecodeMatch, "on-chain bytecode matches artifact");

  if (onChainCode === "0x") return;
  if (!bytecodeMatch) {
    console.log("  ℹ  Bytecode mismatch — this is the OLD contract. Deploy the new one first.");
    return;
  }

  const contract = await hre.ethers.getContractAt("FlashLoan", address);
  const [deployer] = await hre.ethers.getSigners();

  // state checks
  const owner   = await contract.owner();
  const paused  = await contract.paused();
  const poolAddr = await contract.POOL();
  const provider_ = await contract.ADDRESSES_PROVIDER();

  check(owner === deployer.address, `owner is deployer (${owner})`);
  check(!paused, "contract is NOT paused after fresh deploy");
  check(poolAddr !== hre.ethers.ZeroAddress, `POOL resolved: ${poolAddr}`);
  check(provider_ !== hre.ethers.ZeroAddress, `ADDRESSES_PROVIDER set: ${provider_}`);

  // deployer should be whitelisted
  const isWhitelisted = await contract.whitelist(deployer.address);
  check(isWhitelisted, "deployer is whitelisted");

  // pause round-trip — only if we have a funded signer (PRIVATE_KEY set)
  const signers = await hre.ethers.getSigners();
  const hasSigner = signers.length > 0 && (await provider.getBalance(signers[0].address)) > 0n;
  if (hasSigner) {
    const pauseTx = await contract.pause();
    await pauseTx.wait();
    check(await contract.paused(), "pause() works");

    const unpauseTx = await contract.unpause();
    await unpauseTx.wait();
    check(!(await contract.paused()), "unpause() works");
  } else {
    console.log("  ℹ  pause/unpause skipped (no PRIVATE_KEY with ETH — set to test write functions)");
  }

  console.log("\n  All on-chain checks done.");
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const artifact = await checkArtifact();
  if (!artifact) {
    console.error("\nArtifact missing — run `npx hardhat compile` first.");
    process.exitCode = 1;
    return;
  }

  const address = process.env.DEPLOYED_ADDRESS
    || (fs.existsSync(path.join(__dirname, "..", "deployed.json"))
        ? JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed.json"))).address
        : null);

  if (address) {
    await checkOnChain(artifact, address);
  } else {
    console.log("\n── Phase 2: skipped (set DEPLOYED_ADDRESS or deploy first) ───");
  }

  if (process.exitCode === 1) {
    console.error("\n❌  Verification FAILED — see ✘ items above.");
  } else {
    console.log("\n✅  All checks passed.");
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
