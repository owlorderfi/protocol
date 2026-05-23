// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/**
 * @notice Minimal WETH9-style mock. Exact same `transfer()` semantics
 *         in withdraw() that production WETH/WPOL uses — important for
 *         exercising the EIP-7702 OOG path that motivates router.unwrap().
 */
contract MockWETH9 {
    string public name = "Mock Wrapped";
    string public symbol = "MOCK";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "MockWETH9: insufficient");
        balanceOf[msg.sender] -= wad;
        // The bug path the helper avoids: 2300 gas stipend.
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "MockWETH9: insufficient");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "MockWETH9: not approved");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
