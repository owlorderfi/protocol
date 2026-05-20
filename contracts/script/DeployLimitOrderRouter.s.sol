// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LimitOrderRouter} from "../src/LimitOrderRouter.sol";

/**
 * @title DeployLimitOrderRouter
 * @notice Deploys LimitOrderRouter to the target chain.
 *
 * Required env vars (from .env or shell):
 *   - DEPLOYER_PRIVATE_KEY    : signer for deployment tx
 *   - INITIAL_OWNER           : owner of router (admin functions)
 *   - INITIAL_FEE_RECIPIENT   : address receiving protocol fees
 *   - INITIAL_FEE_BPS         : fee in basis points (1-100; 25 = 0.25%)
 *   - INITIAL_KEEPER          : address authorized to call executeOrder
 *
 * Usage:
 *   forge script script/DeployLimitOrderRouter.s.sol \
 *       --rpc-url amoy \
 *       --broadcast \
 *       --verify \
 *       -vvv
 */
contract DeployLimitOrderRouter is Script {
    function run() external returns (LimitOrderRouter router) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address initialOwner = vm.envAddress("INITIAL_OWNER");
        address feeRecipient = vm.envAddress("INITIAL_FEE_RECIPIENT");
        uint256 feeBpsRaw = vm.envUint("INITIAL_FEE_BPS");
        address initialKeeper = vm.envAddress("INITIAL_KEEPER");

        require(feeBpsRaw <= 100, "Fee too high (max 100 bp = 1%)");
        uint16 feeBps = uint16(feeBpsRaw);

        console.log("Deploying LimitOrderRouter...");
        console.log("  Chain id:        ", block.chainid);
        console.log("  Deployer:        ", vm.addr(deployerKey));
        console.log("  Initial owner:   ", initialOwner);
        console.log("  Fee recipient:   ", feeRecipient);
        console.log("  Fee bps:         ", feeBps);
        console.log("  Initial keeper:  ", initialKeeper);

        vm.startBroadcast(deployerKey);
        router = new LimitOrderRouter(initialOwner, feeRecipient, feeBps, initialKeeper);
        vm.stopBroadcast();

        console.log("");
        console.log("LimitOrderRouter deployed at:", address(router));

        // Log EIP-712 domain (per EIP-5267) for off-chain signing setup
        (, string memory name, string memory version, uint256 chainId, address verifyingContract, , ) =
            router.eip712Domain();
        console.log("EIP-712 domain:");
        console.log("  name:              ", name);
        console.log("  version:           ", version);
        console.log("  chainId:           ", chainId);
        console.log("  verifyingContract: ", verifyingContract);
    }
}
