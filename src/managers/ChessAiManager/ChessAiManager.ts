import { Chess, ChessInstance, Move, PieceColor } from "chess.js";
import { PIECE_SQUARE_TABLES, PIECE_WEIGHTS } from "constants/chess-weights";
import { PieceSquareTables } from "constants/types";
import cloneDeep from "lodash.clonedeep";
import { getMatrixPosition } from "utils/chess";
import { PieceSet } from "managers/PiecesManager/types";
import { PieceChessPosition } from "objects/Pieces/Piece/types";
import { PromotionWebWorkerEvent } from "managers/ChessBoardManager/types";

// based on https://dev.to/zeyu2001/build-a-simple-chess-ai-in-javascript-18eg
export class ChessAiManager {
  private color: PieceColor;
  private aiSquareTables: PieceSquareTables;
  private opponentSquareTables: PieceSquareTables;
  private chessEngine: ChessInstance;
  private prevSum = 0;

  constructor() {
    this.chessEngine = new Chess();
  }

  private reverseSquareTablesForBlack(): PieceSquareTables {
    const cloned = cloneDeep(PIECE_SQUARE_TABLES);

    for (const value of Object.values(cloned)) {
      value.reverse();
    }

    return cloned;
  }

  private blackStartInit(): void {
    this.aiSquareTables = this.reverseSquareTablesForBlack();
    this.opponentSquareTables = cloneDeep(PIECE_SQUARE_TABLES);
  }

  private whiteStartInit(): void {
    this.aiSquareTables = cloneDeep(PIECE_SQUARE_TABLES);
    this.opponentSquareTables = this.reverseSquareTablesForBlack();
  }

  private getOpponentValueFromSquareTable(
    piece: keyof PieceSet,
    chessPosition: PieceChessPosition
  ): number {
    const { row, column } = chessPosition;
    return this.opponentSquareTables[piece][row][column];
  }

  private getAiValueFromSquareTable(
    piece: keyof PieceSet,
    chessPosition: PieceChessPosition
  ): number {
    const { row, column } = chessPosition;
    return this.aiSquareTables[piece][row][column];
  }

  private evaluateBoard(move: Move, prevSum: number): number {
    let newSum = prevSum;
    const { row: fromRow, column: fromColumn } = getMatrixPosition(move.from);
    const { row: toRow, column: toColumn } = getMatrixPosition(move.to);
    const { captured, color: moveColor, piece } = move;

    if (captured) {
      // ai captured a piece
      if (moveColor === this.color) {
        newSum +=
          PIECE_WEIGHTS[captured] +
          this.getAiValueFromSquareTable(captured, {
            row: toRow,
            column: toColumn,
          });
      }
      // player captured a piece
      else {
        newSum -=
          PIECE_WEIGHTS[captured] +
          this.getOpponentValueFromSquareTable(captured, {
            row: toRow,
            column: toColumn,
          });
      }
    }

    if (move.flags === "p") {
      const promoted = "q";

      // ai piece was promoted
      if (moveColor === this.color) {
        newSum -=
          PIECE_WEIGHTS[piece] +
          this.getAiValueFromSquareTable(piece, {
            row: fromRow,
            column: fromColumn,
          });

        newSum +=
          PIECE_WEIGHTS[promoted] +
          this.getAiValueFromSquareTable(promoted, {
            row: fromRow,
            column: fromColumn,
          });
      }
      // player piece was promoted
      else {
        newSum +=
          PIECE_WEIGHTS[piece] +
          this.getOpponentValueFromSquareTable(piece, {
            row: fromRow,
            column: fromColumn,
          });

        newSum -=
          PIECE_WEIGHTS[promoted] +
          this.getOpponentValueFromSquareTable(piece, {
            row: toRow,
            column: toColumn,
          });
      }
    }
    // regular move
    else {
      // if ai moves
      if (moveColor === this.color) {
        newSum -= this.getAiValueFromSquareTable(piece, {
          row: fromRow,
          column: fromColumn,
        });
        newSum += this.getAiValueFromSquareTable(piece, {
          row: toRow,
          column: toColumn,
        });
      }
      // if player moves
      else {
        newSum += this.getAiValueFromSquareTable(piece, {
          row: fromRow,
          column: fromColumn,
        });
        newSum -= this.getAiValueFromSquareTable(piece, {
          row: toRow,
          column: toColumn,
        });
      }
    }

    return newSum;
  }

  private minimax(
    depth: number,
    sum: number,
    isMaximizingPlayer: boolean,
    alpha: number,
    beta: number
  ): [Move, number] {
    let maxVal = -Infinity;
    let bestMove: Move;
    let minVal = +Infinity;
    let currentMove: Move;
    const moves = this.chessEngine.moves();

    if (depth === 0 || moves.length === 0) {
      return [null, sum];
    }

    for (const moveNotation of moves) {
      currentMove = this.chessEngine.move(moveNotation);
      const newSum = this.evaluateBoard(currentMove, sum);
      const [_, childValue] = this.minimax(
        depth - 1,
        newSum,
        !isMaximizingPlayer,
        alpha,
        beta
      );

      this.chessEngine.undo();

      if (isMaximizingPlayer) {
        if (childValue > maxVal) {
          maxVal = childValue;
          bestMove = currentMove;
        }

        alpha = Math.max(alpha, childValue);
        if (beta <= alpha) {
          break;
        }
      } else {
        if (childValue < minVal) {
          minVal = childValue;
          bestMove = currentMove;
        }
        beta = Math.min(childValue, beta);

        if (beta <= alpha) {
          break;
        }
      }
    }

    if (isMaximizingPlayer) {
      return [bestMove, maxVal];
    }

    return [bestMove, minVal];
  }

  isWhite(): boolean {
    return this.color === "w";
  }

  isBlack(): boolean {
    return this.color === "b";
  }

  init(color: PieceColor, fen: string): void {
    this.color = color;
    this.chessEngine.load(fen);

    if (this.isBlack()) {
      this.blackStartInit();
      return;
    }

    this.whiteStartInit();
  }

  updateBoardWithPlayerMove(move: Move): void {
    this.chessEngine.move(move);
    this.prevSum = this.evaluateBoard(move, this.prevSum);
  }

  updateChessEngineWithPromotion(payload: PromotionWebWorkerEvent): void {
    const { move, chessNotationPos, pieceType, color } = payload;

    if (move) {
      this.chessEngine.move(move);
    }

    this.chessEngine.remove(chessNotationPos);
    this.chessEngine.put({ type: pieceType, color }, chessNotationPos);

    // related to bug https://github.com/jhlywa/chess.js/issues/250
    this.chessEngine.load(this.chessEngine.fen());
  }

  calcAiMove(): Move {
    const [move, sum] = this.minimax(
      3,
      this.prevSum,
      true,
      -Infinity,
      +Infinity
    );

    this.prevSum = sum;
    this.chessEngine.move(move);

    return move;
  }
}
