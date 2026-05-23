// SPDX-License-Identifier: BUSL-1.1
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
 *   - INITIAL_KEEPER          : address authorized to call executeOrder
 *
 * Note: per-order fee is signed by the maker; there is no global feeBps.
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
        address initialKeeper = vm.envAddress("INITIAL_KEEPER");

        console.log("Deploying LimitOrderRouter...");
        console.log("  Chain id:        ", block.chainid);
        console.log("  Deployer:        ", vm.addr(deployerKey));
        console.log("  Initial owner:   ", initialOwner);
        console.log("  Fee recipient:   ", feeRecipient);
        console.log("  Initial keeper:  ", initialKeeper);

        vm.startBroadcast(deployerKey);
        router = new LimitOrderRouter(initialOwner, feeRecipient, initialKeeper);
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
