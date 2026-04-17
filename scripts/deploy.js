const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Aave V3 PoolAddressesProvider addresses
const ADDRESSES_PROVIDER = {
  sepolia: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A",
  mainnet: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
};

async function main() {
  const network = hre.network.name;
  const provider = ADDRESSES_PROVIDER[network];

  if (!provider) {
    throw new Error(`No Aave PoolAddressesProvider configured for network: ${network}`);
  }

  console.log(`Deploying FlashLoan to ${network}...`);
  console.log(`Aave PoolAddressesProvider: ${provider}`);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const FlashLoan = await hre.ethers.getContractFactory("FlashLoan");
  const contract = await FlashLoan.deploy(provider);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`FlashLoan deployed to: ${address}`);

  // Write deployment info for Makefile / CI to pick up
  const deployedPath = path.join(__dirname, "..", "deployed.json");
  fs.writeFileSync(
    deployedPath,
    JSON.stringify({ address, network, deployer: deployer.address, timestamp: new Date().toISOString() }, null, 2)
  );
  console.log(`Deployment info saved to not-bot/deployed.json`);
  // Machine-readable marker for grep in Makefile
  console.log(`DEPLOYED_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
