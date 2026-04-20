require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    ...((process.env.DEPLOY_RPC_URL || process.env.ETH_RPC_URL)
      ? {
          mainnet: {
            url: process.env.DEPLOY_RPC_URL || process.env.ETH_RPC_URL,
            ...(process.env.PRIVATE_KEY ? { accounts: [process.env.PRIVATE_KEY] } : {}),
          },
        }
      : {}),
    ...(process.env.INFURA_SEPOLIA_ENDPOINT && process.env.PRIVATE_KEY
      ? {
          sepolia: {
            url: process.env.INFURA_SEPOLIA_ENDPOINT,
            accounts: [process.env.PRIVATE_KEY],
          },
        }
      : {}),
  },
};
