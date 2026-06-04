// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentCheckersEscrow.sol";

/// @notice Deploy the escrow. Set USDC_ADDRESS and HOUSE_WALLET env vars.
///   Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///   Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
contract DeployEscrow is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address houseWallet = vm.envAddress("HOUSE_WALLET");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        AgentCheckersEscrow escrow = new AgentCheckersEscrow(usdc, houseWallet);
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
    }
}
