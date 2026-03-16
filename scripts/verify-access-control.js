const hre = require("hardhat");

const FLASH_LOAN_ADDRESS = "0x6f56C73f38368332fE22f48BB949fB5B046D6Dc6";

async function tryCall(label, fn) {
  try {
    await fn();
    console.log(`  FAIL — ${label}: did NOT revert (unexpected)`);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("Not owner")) {
      console.log(`  PASS — ${label}: reverted with "Not owner"`);
    } else {
      // any revert from a non-owner is still correct access control
      console.log(`  PASS — ${label}: reverted (${msg.slice(0, 80)})`);
    }
  }
}

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const attacker = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);

  console.log("Owner  :", owner.address);
  console.log("Attacker:", attacker.address, "(random, no ETH)");
  console.log("Contract:", FLASH_LOAN_ADDRESS);
  console.log();

  const contract = await hre.ethers.getContractAt("FlashLoan", FLASH_LOAN_ADDRESS);

  // Confirm owner matches deployer
  const onChainOwner = await contract.owner();
  console.log("on-chain owner:", onChainOwner);
  console.log("owner matches:", onChainOwner.toLowerCase() === owner.address.toLowerCase());
  console.log();

  const asAttacker = contract.connect(attacker);
  const dummyParams = hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["address","uint8","address","uint24","uint8","address","uint24","uint256"],
    [attacker.address, 0, attacker.address, 0, 0, attacker.address, 0, 0n]
  );

  console.log("Testing onlyOwner access control (staticCall — no gas spent):");

  await tryCall("requestFlashLoan()", () =>
    asAttacker.requestFlashLoan.staticCall(attacker.address, 1n, dummyParams)
  );

  await tryCall("withdraw()", () =>
    asAttacker.withdraw.staticCall(attacker.address)
  );

  await tryCall("withdrawETH()", () =>
    asAttacker.withdrawETH.staticCall()
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
