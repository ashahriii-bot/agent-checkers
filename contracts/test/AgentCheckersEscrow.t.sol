// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AgentCheckersEscrow.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract AgentCheckersEscrowTest is Test {
    AgentCheckersEscrow escrow;
    MockUSDC usdc;

    address house = address(0xH0);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant BET = 500_000; // $0.50 in 6-decimal USDC
    bytes32 constant MATCH = keccak256("match-1");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new AgentCheckersEscrow(address(usdc), house);
        usdc.mint(alice, 100_000_000);
        usdc.mint(bob, 100_000_000);
        vm.prank(alice); usdc.approve(address(escrow), type(uint256).max);
        vm.prank(bob); usdc.approve(address(escrow), type(uint256).max);
    }

    function _createAndFund() internal {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        vm.prank(bob); escrow.joinMatch(MATCH);
    }

    function testCreateEscrowsStake() public {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        assertEq(usdc.balanceOf(address(escrow)), BET);
        (address pa,, uint256 amt, AgentCheckersEscrow.MatchStatus st,,) = escrow.matches(MATCH);
        assertEq(pa, alice);
        assertEq(amt, BET);
        assertEq(uint8(st), uint8(AgentCheckersEscrow.MatchStatus.Open));
    }

    function testCannotCreateDuplicate() public {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        vm.prank(bob); vm.expectRevert("match exists"); escrow.createMatch(MATCH, BET);
    }

    function testJoinFunds() public {
        _createAndFund();
        assertEq(usdc.balanceOf(address(escrow)), BET * 2);
    }

    function testCannotJoinOwnMatch() public {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        vm.prank(alice); vm.expectRevert("cannot join own match"); escrow.joinMatch(MATCH);
    }

    function testSettleWinnerGets95Percent() public {
        _createAndFund();
        uint256 pot = BET * 2;
        uint256 fee = pot * 500 / 10000; // 5%
        uint256 aliceBefore = usdc.balanceOf(alice);

        escrow.settleMatch(MATCH, alice); // owner is test contract

        assertEq(usdc.balanceOf(alice), aliceBefore + pot - fee);
        assertEq(usdc.balanceOf(house), fee);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testSettleDrawSplitsPostFee() public {
        _createAndFund();
        uint256 pot = BET * 2;
        uint256 fee = pot * 500 / 10000;
        uint256 each = (pot - fee) / 2;
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);

        escrow.settleMatch(MATCH, address(0));

        assertEq(usdc.balanceOf(alice), aBefore + each);
        assertEq(usdc.balanceOf(bob), bBefore + each);
        assertEq(usdc.balanceOf(house), fee);
    }

    function testOnlyOwnerSettles() public {
        _createAndFund();
        vm.prank(bob);
        vm.expectRevert();
        escrow.settleMatch(MATCH, bob);
    }

    function testSettleRejectsInvalidWinner() public {
        _createAndFund();
        vm.expectRevert("invalid winner");
        escrow.settleMatch(MATCH, address(0xDEAD));
    }

    function testCancelRefundsCreator() public {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        uint256 before = usdc.balanceOf(alice);
        escrow.cancelMatch(MATCH); // owner can cancel anytime
        assertEq(usdc.balanceOf(alice), before + BET);
    }

    function testCreatorCancelRequiresDelay() public {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        vm.prank(alice); vm.expectRevert("not authorized"); escrow.cancelMatch(MATCH);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(alice); escrow.cancelMatch(MATCH); // now allowed
    }

    function testFeeCapEnforced() public {
        vm.expectRevert("fee too high");
        escrow.updateHouseFee(1001);
    }

    function testCannotSettleUnfunded() public {
        vm.prank(alice); escrow.createMatch(MATCH, BET);
        vm.expectRevert("not funded");
        escrow.settleMatch(MATCH, alice);
    }
}
