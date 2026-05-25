// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LimitOrderRouter} from "../src/LimitOrderRouter.sol";

/**
 * @title DeployLimitOrderRouter
 * @notice Deploys LimitOrderRouter to the target chain and applies the
 *         chain-specific post-deploy configuration (nativeWrappedToken,
 *         keeperReserveTarget, per-token sweepThresholds).
 *
 * Required env vars (from .env or shell):
 *   - DEPLOYER_PRIVATE_KEY    : signer for deployment tx
 *   - INITIAL_OWNER           : owner of router (admin functions)
 *   - INITIAL_FEE_RECIPIENT   : address receiving protocol fees
 *   - INITIAL_KEEPER          : address authorized to call executeOrder
 *
 * Note: per-order fee is signed by the maker; there is no global feeBps.
 *
 * Post-deploy setters run automatically when the deployer == INITIAL_OWNER.
 * If ownership is split (multisig pattern), the script logs the calls the
 * owner needs to execute separately.
 *
 * Usage:
 *   forge script script/DeployLimitOrderRouter.s.sol \
 *       --rpc-url base_sepolia \
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
        address deployerAddr = vm.addr(deployerKey);

        console.log("Deploying LimitOrderRouter...");
        console.log("  Chain id:        ", block.chainid);
        console.log("  Deployer:        ", deployerAddr);
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

        // ─── Post-deploy configuration ──────────────────────────────────
        // setters are onlyOwner. When deployer == owner we run them
        // in the same broadcast — otherwise the owner needs to execute
        // them manually (logged below).
        if (deployerAddr == initialOwner) {
            console.log("");
            console.log("Applying chain-specific config (deployer == owner)...");
            vm.startBroadcast(deployerKey);
            _configurePostDeploy(router);
            vm.stopBroadcast();
            console.log("Post-deploy config applied.");
        } else {
            console.log("");
            console.log("WARNING: deployer != initialOwner.");
            console.log("Owner must call these setters manually:");
            _logManualSetupChecklist();
        }
    }

    // ─── Chain-specific config dispatch ─────────────────────────────────
    //
    // Per-chain block describes:
    //   - wrappedNative (WETH / WPOL / WAVAX / ...)
    //   - keeperReserveTarget (in native wei — what the contract keeps
    //     accumulated for keeper gas refills)
    //   - per-token sweepThreshold (~$10 equivalent at time of writing
    //     — owner reviews on major price moves)

    function _configurePostDeploy(LimitOrderRouter router) internal {
        uint256 cid = block.chainid;

        if (cid == 8453) {
            // Base mainnet — ETH native, ~$3300 ETH at time of writing
            router.setNativeWrappedToken(0x4200000000000000000000000000000000000006);
            router.setKeeperReserveTarget(0.02 ether); // ~$66
            // USDC + USDT
            router.setSweepThreshold(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 10_000_000);
            router.setSweepThreshold(0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, 10_000_000);
            // cbBTC (8 dec) — 0.0001 BTC ≈ $10 @ $100k
            router.setSweepThreshold(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, 10_000);
        } else if (cid == 84532) {
            // Base Sepolia — same WETH, threshold cosmetic on testnet
            router.setNativeWrappedToken(0x4200000000000000000000000000000000000006);
            router.setKeeperReserveTarget(0.02 ether);
            // USDC (Circle testnet)
            router.setSweepThreshold(0x036CbD53842c5426634e7929541eC2318f3dCF7e, 10_000_000);
        } else if (cid == 421614) {
            // Arbitrum Sepolia — Nitro, not OP-stack; WETH at the
            // Uniswap-deployment canonical address (not 0x4200...).
            router.setNativeWrappedToken(0x980B62Da83eFf3D4576C647993b0c1D7faf17c73);
            router.setKeeperReserveTarget(0.02 ether);
            // USDC (Circle testnet)
            router.setSweepThreshold(0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, 10_000_000);
            // LINK (18 dec) — testnet faucet drops 25 at a time, so
            // 0.5 LINK threshold = 2 faucet hits before auto-sweep.
            router.setSweepThreshold(0xb1D4538B4571d411F07960EF2838Ce337FE1E80E, 0.5 ether);
        } else if (cid == 11155420) {
            // Optimism Sepolia — OP-stack, same WETH9 predeploy as Base.
            router.setNativeWrappedToken(0x4200000000000000000000000000000000000006);
            router.setKeeperReserveTarget(0.02 ether);
            // USDC (Circle testnet)
            router.setSweepThreshold(0x5fd84259d66Cd46123540766Be93DFE6D43130D7, 10_000_000);
        } else if (cid == 137) {
            // Polygon PoS — POL native, ~$0.30 POL at time of writing
            router.setNativeWrappedToken(0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270);
            router.setKeeperReserveTarget(10 ether); // ~10 POL ≈ $3
            // USDC (native Circle)
            router.setSweepThreshold(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, 10_000_000);
            // USDT
            router.setSweepThreshold(0xc2132D05D31c914a87C6611C10748AEb04B58e8F, 10_000_000);
            // DAI (18 dec)
            router.setSweepThreshold(0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063, 10 ether);
            // WBTC (8 dec) — 0.0001 BTC ≈ $10 @ $100k
            router.setSweepThreshold(0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6, 10_000);
            // LINK (18 dec) — 0.5 LINK ≈ $10 @ $20
            router.setSweepThreshold(0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39, 0.5 ether);
            // AAVE (18 dec) — 0.05 AAVE ≈ $10 @ $200
            router.setSweepThreshold(0xD6DF932A45C0f255f85145f286eA0b292B21C90B, 0.05 ether);
        } else if (cid == 31337) {
            // Anvil (Polygon fork) — same as Polygon mainnet
            router.setNativeWrappedToken(0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270);
            router.setKeeperReserveTarget(10 ether);
            router.setSweepThreshold(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, 10_000_000);
        } else {
            console.log("WARNING: chain", cid, "has no post-deploy config block - router deployed with defaults.");
            console.log("  Defaults: nativeWrappedToken=0, reserveTarget=0.02 ether, all sweepThresholds=0");
            console.log("  Add a block to _configurePostDeploy() before relying on the keeper-refill flow.");
        }
    }

    function _logManualSetupChecklist() internal view {
        uint256 cid = block.chainid;
        if (cid == 8453) {
            console.log("  setNativeWrappedToken(0x4200000000000000000000000000000000000006)");
            console.log("  setKeeperReserveTarget(0.02 ether)");
            console.log("  setSweepThreshold(USDC=0x8335..2913, 10_000_000)");
            console.log("  setSweepThreshold(USDT=0xfde4..99bb2, 10_000_000)");
            console.log("  setSweepThreshold(cbBTC=0xcbB7..d33Bf, 10_000)");
        } else if (cid == 84532) {
            console.log("  setNativeWrappedToken(0x4200000000000000000000000000000000000006)");
            console.log("  setKeeperReserveTarget(0.02 ether)");
            console.log("  setSweepThreshold(USDC=0x036C..CF7e, 10_000_000)");
        } else if (cid == 421614) {
            console.log("  setNativeWrappedToken(0x980B62Da83eFf3D4576C647993b0c1D7faf17c73)");
            console.log("  setKeeperReserveTarget(0.02 ether)");
            console.log("  setSweepThreshold(USDC=0x75faf..AA4d, 10_000_000)");
            console.log("  setSweepThreshold(LINK=0xb1D45..E80E, 0.5 ether)");
        } else if (cid == 11155420) {
            console.log("  setNativeWrappedToken(0x4200000000000000000000000000000000000006)");
            console.log("  setKeeperReserveTarget(0.02 ether)");
            console.log("  setSweepThreshold(USDC=0x5fd84..30D7, 10_000_000)");
        } else if (cid == 137) {
            console.log("  setNativeWrappedToken(0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270)");
            console.log("  setKeeperReserveTarget(10 ether)");
            console.log("  setSweepThreshold(USDC, 10_000_000)");
            console.log("  setSweepThreshold(USDT, 10_000_000)");
            console.log("  setSweepThreshold(DAI, 10 ether)");
            console.log("  setSweepThreshold(WBTC, 10_000)");
            console.log("  setSweepThreshold(LINK, 0.5 ether)");
            console.log("  setSweepThreshold(AAVE, 0.05 ether)");
        } else {
            console.log("  (no chain-specific block for chain", cid, ")");
        }
    }
}
