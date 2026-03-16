require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();


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
