// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentCheckersEscrow
/// @notice Holds USDC stakes for head-to-head Agent Checkers matches and pays out on
///         server-reported results. The server (owner) is the match oracle; the contract
///         provides financial trustlessness: once funded, only the contract releases funds,
///         and every settlement emits a public, auditable event.
contract AgentCheckersEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    uint256 public houseFeeBps = 500; // 5% = 500 basis points
    uint256 public constant MAX_FEE_BPS = 1000; // hard cap 10%
    address public houseWallet;

    // Open matches can be cancelled by the creator after this delay if no one joins.
    uint256 public constant CANCEL_DELAY = 1 hours;

    enum MatchStatus { None, Open, Funded, Settled, Cancelled }

    struct Match {
        address playerA;
        address playerB;
        uint256 betAmount;
        MatchStatus status;
        address winner; // address(0) means draw once settled
        uint64 createdAt;
    }

    mapping(bytes32 => Match) public matches;

    event MatchCreated(bytes32 indexed matchId, address indexed playerA, uint256 betAmount);
    event MatchFunded(bytes32 indexed matchId, address indexed playerB);
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 payout, uint256 houseFee);
    event MatchCancelled(bytes32 indexed matchId);
    event HouseFeeUpdated(uint256 newFeeBps);
    event HouseWalletUpdated(address newWallet);

    constructor(address _usdc, address _houseWallet) Ownable(msg.sender) {
        require(_usdc != address(0) && _houseWallet != address(0), "zero addr");
        usdc = IERC20(_usdc);
        houseWallet = _houseWallet;
    }

    /// @notice Player A creates a match and escrows their stake.
    function createMatch(bytes32 matchId, uint256 betAmount) external nonReentrant {
        require(matches[matchId].status == MatchStatus.None, "match exists");
        require(betAmount > 0, "bet required");

        matches[matchId] = Match({
            playerA: msg.sender,
            playerB: address(0),
            betAmount: betAmount,
            status: MatchStatus.Open,
            winner: address(0),
            createdAt: uint64(block.timestamp)
        });

        usdc.safeTransferFrom(msg.sender, address(this), betAmount);
        emit MatchCreated(matchId, msg.sender, betAmount);
    }

    /// @notice Player B joins an open match and escrows a matching stake.
    function joinMatch(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "not open");
        require(msg.sender != m.playerA, "cannot join own match");

        m.playerB = msg.sender;
        m.status = MatchStatus.Funded;

        usdc.safeTransferFrom(msg.sender, address(this), m.betAmount);
        emit MatchFunded(matchId, msg.sender);
    }

    /// @notice Owner (server oracle) reports the result and releases funds.
    /// @param winner the winning player address, or address(0) for a draw.
    function settleMatch(bytes32 matchId, address winner) external onlyOwner nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.Funded, "not funded");

        uint256 pot = m.betAmount * 2;
        uint256 houseFee = (pot * houseFeeBps) / 10000;

        // Effects before interactions.
        m.winner = winner;
        m.status = MatchStatus.Settled;

        if (winner == address(0)) {
            // Draw: split the post-fee pot evenly.
            uint256 drawReturn = (pot - houseFee) / 2;
            usdc.safeTransfer(m.playerA, drawReturn);
            usdc.safeTransfer(m.playerB, drawReturn);
        } else {
            require(winner == m.playerA || winner == m.playerB, "invalid winner");
            usdc.safeTransfer(winner, pot - houseFee);
        }
        usdc.safeTransfer(houseWallet, houseFee);

        emit MatchSettled(matchId, winner, pot - houseFee, houseFee);
    }

    /// @notice Cancel an unfunded match and refund player A.
    ///         Creator may cancel after CANCEL_DELAY; owner may cancel anytime.
    function cancelMatch(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "not open");
        bool isOwner = msg.sender == owner();
        bool isCreatorAfterDelay = msg.sender == m.playerA && block.timestamp >= m.createdAt + CANCEL_DELAY;
        require(isOwner || isCreatorAfterDelay, "not authorized");

        uint256 refund = m.betAmount;
        m.status = MatchStatus.Cancelled;
        usdc.safeTransfer(m.playerA, refund);
        emit MatchCancelled(matchId);
    }

    function updateHouseFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "fee too high");
        houseFeeBps = newFeeBps;
        emit HouseFeeUpdated(newFeeBps);
    }

    function updateHouseWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "zero addr");
        houseWallet = newWallet;
        emit HouseWalletUpdated(newWallet);
    }
}
