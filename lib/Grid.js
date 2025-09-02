export class Grid {
  constructor() {
    this.grid = [];
  }

  add(element, position) {
    if (!position) {
      this._addStart(element);
      return;
    }

    const [row, col] = position;
    if (!row && !col) {
      this._addStart(element);
      return;
    }

    if (!this.grid[row]) {
      this.grid[row] = [];
    }

    if (this.grid[row][col]) {
      throw new Error('Grid is occupied please ensure the place you insert at is not occupied');
    }

    this.grid[row][col] = element;
  }

  createRow(afterIndex) {
    if (!afterIndex && !Number.isInteger(afterIndex)) {
      this.grid.push([]);
    } else {
      this.grid.splice(afterIndex + 1, 0, []);
    }
  }

  _addStart(element) {
    this.grid.push([element]);
  }

  addAfter(element, newElement) {
    if (!element) {
      this._addStart(newElement);
    }
    const [row, col] = this.find(element);
    if (row < 0 || !this.grid[row]) {
      // element not placed yet; append new row with newElement
      this.grid.push([newElement]);
      return;
    }
    if (col < 0) {
      // no column found, push at end of row
      this.grid[row].push(newElement);
      return;
    }
    this.grid[row].splice(col + 1, 0, newElement);
  }

  addBelow(element, newElement) {
    if (!element) {
      this._addStart(newElement);
    }

    const [row, col] = this.find(element);
    if (row < 0 || col < 0) {
      // element not yet in grid
      this._addStart(newElement);
      return;
    }

    // We are at the bottom of the current grid - add empty row below
    if (!this.grid[row + 1]) {
      this.grid[row + 1] = [];
    }

    // The element below is already occupied - insert new row
    if (this.grid[row + 1][col]) {
      this.grid.splice(row + 1, 0, []);
    }

    if (this.grid[row + 1][col]) {
      throw new Error('Grid is occupied and we could not find a place - this should not happen');
    }

    this.grid[row + 1][col] = newElement;
  }

  find(element) {
    let row, col;
    row = this.grid.findIndex((row) => {
      col = row.findIndex((el) => {
        return el === element;
      });

      return col !== -1;
    });

    return [row, col];
  }

  get(row, col) {
    return (this.grid[row] || [])[col];
  }

  getElementsInRange({ row: startRow, col: startCol }, { row: endRow, col: endCol }) {
    const elements = [];

    if (startRow > endRow) {
      [startRow, endRow] = [endRow, startRow];
    }

    if (startCol > endCol) {
      [startCol, endCol] = [endCol, startCol];
    }

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const element = this.get(row, col);

        if (element) {
          elements.push(element);
        }
      }
    }

    return elements;
  }

  adjustGridPosition(element) {
    let [row, col] = this.find(element);
    const [, maxCol] = this.getGridDimensions();

    if (col < maxCol - 1) {

      // add element in next column
      if (row < 0 || !this.grid[row]) return; // element not yet placed – nothing to adjust
      this.grid[row].length = maxCol;
      this.grid[row][maxCol] = element;
      this.grid[row][col] = null;

    }
  }

  adjustRowForMultipleIncoming(elements, currentElement) {
    const results = elements.map(element => this.find(element));

    // filter only rows that currently exist, excluding any future or non-existent rows
    const lowestRow = Math.min(...results
      .map(result => result[0])
      .filter(row => row >= 0));

    const [row, col] = this.find(currentElement);
    if (row < 0 || col < 0) return; // current element not yet in grid

    // if element doesn't already exist in current row, add element
    if (lowestRow < row && this.grid[lowestRow] && !this.grid[lowestRow][col]) {
      this.grid[lowestRow][col] = currentElement;
      this.grid[row][col] = null;
    }
  }

  adjustColumnForMultipleIncoming(elements, currentElement) {
    const results = elements.map(element => this.find(element));
    // collect only valid existing column indices
    const validCols = results.map(r => r[1]).filter(c => c >= 0);
    if (!validCols.length) return; // nothing to base adjustment on
    const maxCol = Math.max(...validCols);

    const [row, col] = this.find(currentElement);
    if (row < 0 || col < 0 || !this.grid[row]) return; // current element not yet placed

    // ensure row array large enough
    if (this.grid[row].length < maxCol + 2) {
      this.grid[row].length = maxCol + 2;
    }
    // add to the next column
    if (maxCol + 1 > col) {
      this.grid[row][maxCol + 1] = currentElement;
      this.grid[row][col] = null;
    }
  }

  getAllElements() {
    const elements = [];

    for (let row = 0; row < this.grid.length; row++) {
      for (let col = 0; col < this.grid[row].length; col++) {
        const element = this.get(row, col);

        if (element) {
          elements.push(element);
        }
      }
    }

    return elements;
  }

  getGridDimensions() {
    const numRows = this.grid.length;
    let maxCols = 0;

    for (let i = 0; i < numRows; i++) {
      const currentRowLength = this.grid[i].length;
      if (currentRowLength > maxCols) {
        maxCols = currentRowLength;
      }
    }

    return [numRows, maxCols];
  }

  elementsByPosition() {
    const elements = [];

    this.grid.forEach((row, rowIndex) => {
      row.forEach((element, colIndex) => {
        if (!element) {
          return;
        }
        elements.push({
          element,
          row: rowIndex,
          col: colIndex
        });
      });
    });

    return elements;
  }

  getElementsTotal() {
    const flattenedGrid = this.grid.flat();
    const uniqueElements = new Set(flattenedGrid.filter(value => value));
    return uniqueElements.size;
  }
}