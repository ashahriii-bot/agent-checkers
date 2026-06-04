"""Checkers game engine. Handles board state, move generation, game rules, and shrinking board."""

from dataclasses import dataclass, field
from enum import IntEnum
import random

SIZE = 8

# dead zone marker (shrinking board)
DEAD = -1


class Piece(IntEnum):
    EMPTY = 0
    RED = 1
    BLACK = 2
    RED_KING = 3
    BLACK_KING = 4


def is_red(p: int) -> bool:
    return p in (Piece.RED, Piece.RED_KING)


def is_black(p: int) -> bool:
    return p in (Piece.BLACK, Piece.BLACK_KING)


def is_king(p: int) -> bool:
    return p in (Piece.RED_KING, Piece.BLACK_KING)


def belongs(p: int, side: str) -> bool:
    return is_red(p) if side == "red" else is_black(p)


def opponent(side: str) -> str:
    return "black" if side == "red" else "red"


def is_playable(p: int) -> bool:
    """Square is not dead and not empty."""
    return p > 0


@dataclass
class Pos:
    row: int
    col: int

    def to_dict(self):
        return {"row": self.row, "col": self.col}


@dataclass
class Move:
    from_pos: Pos
    to_pos: Pos
    captures: list[Pos] = field(default_factory=list)
    path: list[Pos] = field(default_factory=list)

    def to_dict(self):
        return {
            "from": self.from_pos.to_dict(),
            "to": self.to_pos.to_dict(),
            "captures": [c.to_dict() for c in self.captures],
            "path": [p.to_dict() for p in self.path],
        }


Board = list[list[int]]


def init_board() -> Board:
    board = [[Piece.EMPTY] * SIZE for _ in range(SIZE)]
    for r in range(3):
        for c in range(SIZE):
            if (r + c) % 2 == 1:
                board[r][c] = Piece.BLACK
    for r in range(5, SIZE):
        for c in range(SIZE):
            if (r + c) % 2 == 1:
                board[r][c] = Piece.RED
    return board


def clone_board(b: Board) -> Board:
    return [row[:] for row in b]


def get_directions(piece: int) -> list[tuple[int, int]]:
    if is_king(piece):
        return [(-1, -1), (-1, 1), (1, -1), (1, 1)]
    if is_red(piece):
        return [(-1, -1), (-1, 1)]
    return [(1, -1), (1, 1)]


def get_captures_for_piece(board: Board, row: int, col: int) -> list[Move]:
    piece = board[row][col]
    if piece <= 0:
        return []
    side = "red" if is_red(piece) else "black"
    king_dirs = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
    piece_dirs = king_dirs if is_king(piece) else get_directions(piece)

    def find_jumps(b, r, c, captured, path):
        found = []
        search_dirs = king_dirs if is_king(piece) else piece_dirs
        for dr, dc in search_dirs:
            mr, mc = r + dr, c + dc
            lr, lc = r + 2 * dr, c + 2 * dc
            if (
                0 <= lr < SIZE
                and 0 <= lc < SIZE
                and belongs(b[mr][mc], opponent(side))
                and not any(cp.row == mr and cp.col == mc for cp in captured)
                and b[lr][lc] == Piece.EMPTY
            ):
                new_captured = captured + [Pos(mr, mc)]
                new_path = path + [Pos(lr, lc)]
                nb = clone_board(b)
                nb[lr][lc] = nb[r][c]
                nb[r][c] = Piece.EMPTY
                nb[mr][mc] = Piece.EMPTY
                deeper = find_jumps(nb, lr, lc, new_captured, new_path)
                if deeper:
                    found.extend(deeper)
                else:
                    found.append(
                        Move(
                            from_pos=Pos(row, col),
                            to_pos=Pos(lr, lc),
                            captures=new_captured,
                            path=new_path,
                        )
                    )
        return found

    return find_jumps(board, row, col, [], [])


def get_moves_for_piece(board: Board, row: int, col: int) -> list[Move]:
    piece = board[row][col]
    if piece <= 0:
        return []
    moves = []
    for dr, dc in get_directions(piece):
        nr, nc = row + dr, col + dc
        if 0 <= nr < SIZE and 0 <= nc < SIZE and board[nr][nc] == Piece.EMPTY:
            moves.append(
                Move(
                    from_pos=Pos(row, col),
                    to_pos=Pos(nr, nc),
                    captures=[],
                    path=[Pos(nr, nc)],
                )
            )
    return moves


def get_all_moves(board: Board, side: str) -> list[Move]:
    all_captures = []
    all_moves = []
    for r in range(SIZE):
        for c in range(SIZE):
            if belongs(board[r][c], side):
                all_captures.extend(get_captures_for_piece(board, r, c))
                all_moves.extend(get_moves_for_piece(board, r, c))
    if all_captures:
        max_len = max(len(m.captures) for m in all_captures)
        return [m for m in all_captures if len(m.captures) == max_len]
    return all_moves


def apply_move(board: Board, move: Move) -> Board:
    nb = clone_board(board)
    piece = nb[move.from_pos.row][move.from_pos.col]
    nb[move.from_pos.row][move.from_pos.col] = Piece.EMPTY
    dest = move.path[-1]
    nb[dest.row][dest.col] = piece
    for cap in move.captures:
        nb[cap.row][cap.col] = Piece.EMPTY
    if is_red(piece) and dest.row == 0:
        nb[dest.row][dest.col] = Piece.RED_KING
    if is_black(piece) and dest.row == SIZE - 1:
        nb[dest.row][dest.col] = Piece.BLACK_KING
    return nb


def count_pieces(board: Board) -> dict:
    red = black = red_kings = black_kings = 0
    for r in range(SIZE):
        for c in range(SIZE):
            p = board[r][c]
            if p == Piece.RED:
                red += 1
            elif p == Piece.BLACK:
                black += 1
            elif p == Piece.RED_KING:
                red_kings += 1
            elif p == Piece.BLACK_KING:
                black_kings += 1
    return {
        "red": red + red_kings,
        "black": black + black_kings,
        "red_kings": red_kings,
        "black_kings": black_kings,
    }


def board_to_list(board: Board) -> list[list[int]]:
    return [row[:] for row in board]


# --- shrinking board ---

def get_edge_squares(board: Board) -> list[tuple[int, int]]:
    """Get all non-dead dark squares on the current board edge."""
    edges = []
    alive_rows = set()
    alive_cols = set()
    for r in range(SIZE):
        for c in range(SIZE):
            if board[r][c] != DEAD:
                alive_rows.add(r)
                alive_cols.add(c)

    if not alive_rows or not alive_cols:
        return []

    min_r, max_r = min(alive_rows), max(alive_rows)
    min_c, max_c = min(alive_cols), max(alive_cols)

    for r in range(SIZE):
        for c in range(SIZE):
            if board[r][c] == DEAD:
                continue
            if (r + c) % 2 != 1:
                continue
            if r == min_r or r == max_r or c == min_c or c == max_c:
                edges.append((r, c))
    return edges


def shrink_board(board: Board, num_squares: int = 4) -> tuple[Board, list[dict]]:
    """Kill random edge squares. Returns new board and list of killed squares with any pieces that were on them."""
    nb = clone_board(board)
    edges = get_edge_squares(nb)
    if not edges:
        return nb, []

    random.shuffle(edges)
    killed = []
    for r, c in edges[:num_squares]:
        piece_on = nb[r][c]
        nb[r][c] = DEAD
        killed.append({"row": r, "col": c, "had_piece": piece_on > 0})

    return nb, killed


def apply_king_fatigue(board: Board, fatigue: dict, max_idle: int = 15) -> tuple[Board, dict]:
    """Demote kings that haven't captured in max_idle moves."""
    nb = clone_board(board)
    demoted = {}
    for key, count in fatigue.items():
        if count >= max_idle:
            r, c = map(int, key.split(","))
            if nb[r][c] == Piece.RED_KING:
                nb[r][c] = Piece.RED
                demoted[key] = "red"
            elif nb[r][c] == Piece.BLACK_KING:
                nb[r][c] = Piece.BLACK
                demoted[key] = "black"
    return nb, demoted


# --- position evaluation helpers ---

def calc_material_balance(board: Board, side: str) -> float:
    counts = count_pieces(board)
    if side == "red":
        my_reg = counts["red"] - counts["red_kings"]
        my_k = counts["red_kings"]
        opp_reg = counts["black"] - counts["black_kings"]
        opp_k = counts["black_kings"]
    else:
        my_reg = counts["black"] - counts["black_kings"]
        my_k = counts["black_kings"]
        opp_reg = counts["red"] - counts["red_kings"]
        opp_k = counts["red_kings"]
    return (my_reg + my_k * 1.5) - (opp_reg + opp_k * 1.5)


def calc_advancement(board: Board, side: str) -> float:
    total_adv = 0.0
    count = 0
    for r in range(SIZE):
        for c in range(SIZE):
            p = board[r][c]
            if belongs(p, side) and not is_king(p):
                if side == "red":
                    total_adv += (SIZE - 1 - r) / (SIZE - 1)
                else:
                    total_adv += r / (SIZE - 1)
                count += 1
    return total_adv / count if count > 0 else 0.0


def calc_back_rank_integrity(board: Board, side: str) -> float:
    back_row = SIZE - 1 if side == "red" else 0
    defended = 0
    total = 0
    for c in range(SIZE):
        if (back_row + c) % 2 == 1:
            total += 1
            if belongs(board[back_row][c], side):
                defended += 1
    return defended / total if total > 0 else 0.0


def calc_center_control(board: Board, side: str) -> float:
    center_4 = [(3, 2), (3, 4), (4, 3), (4, 5)]
    center_8_extra = [(2, 3), (2, 5), (5, 2), (5, 4)]
    score = 0.0
    for r, c in center_4:
        if belongs(board[r][c], side):
            score += 2.0
    for r, c in center_8_extra:
        if belongs(board[r][c], side):
            score += 1.0
    return score / 12.0


def calc_formation_quality(board: Board, side: str) -> float:
    protected = 0
    total = 0
    back_dr = 1 if side == "red" else -1
    for r in range(SIZE):
        for c in range(SIZE):
            if not belongs(board[r][c], side):
                continue
            total += 1
            for dc in (-1, 1):
                br, bc = r + back_dr, c + dc
                if 0 <= br < SIZE and 0 <= bc < SIZE and belongs(board[br][bc], side):
                    protected += 1
                    break
    return protected / total if total > 0 else 0.0
