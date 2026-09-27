/**
 * sql.js 局部类型声明（A02 配套）。
 *
 * 为什么不用 @types/sql.js：它带 `/// <reference types="emscripten" />`，会为固定依赖
 * `sql.js@1.14.1` 额外引入一整套 emscripten 类型。这里只声明本实现实际使用到的 API 面。
 * 只有 `src/atlas-db-runtime.ts` 直接 import 本模块声明。
 */

declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export type ParamsObject = Record<string, SqlValue>;
  export type BindParams = SqlValue[] | ParamsObject | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface EmscriptenFileSystem {
    readFile(path: string, opts?: { encoding?: string }): Uint8Array | string;
    writeFile(path: string, data: Uint8Array | string): void;
    unlink(path: string): void;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
    wasmMemory?: unknown;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    FS?: EmscriptenFileSystem;
    [key: string]: unknown;
  }

  export class Statement {
    bind(values?: BindParams): boolean;
    free(): boolean;
    freemem(): void;
    get(params?: BindParams): SqlValue[];
    getAsObject(params?: BindParams): ParamsObject;
    getColumnNames(): string[];
    getNormalizedSQL(): string;
    getSQL(): string;
    reset(): void;
    run(values?: BindParams): void;
    step(): boolean;
  }

  export interface StatementIteratorResult {
    done: boolean;
    value: Statement;
  }

  export class StatementIterator implements Iterable<Statement> {
    [Symbol.iterator](): Iterator<Statement>;
    getRemainingSQL(): string;
    next(): StatementIteratorResult;
  }

  export class Database {
    constructor(data?: ArrayLike<number> | null);
    close(): void;
    create_function(name: string, func: (...args: unknown[]) => unknown): Database;
    each(sql: string, params: BindParams, callback: (obj: ParamsObject) => void, done: () => void): Database;
    each(sql: string, callback: (obj: ParamsObject) => void, done: () => void): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    export(): Uint8Array;
    getRowsModified(): number;
    handleError(): null | never;
    iterateStatements(sql: string): StatementIterator;
    prepare(sql: string, params?: BindParams): Statement;
    run(sql: string, params?: BindParams): Database;
    updateHook(callback: ((operation: 'insert' | 'update' | 'delete', database: string, table: string, rowId: number) => void) | null): Database;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
    Statement: typeof Statement;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
