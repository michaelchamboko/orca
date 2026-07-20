declare module "better-sqlite3" {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  export interface Statement<TParams = Record<string, unknown>, TResult = unknown> {
    run(params?: TParams): RunResult;
    get(params?: TParams): TResult | undefined;
    all(params?: TParams): TResult[];
  }

  export class Database {
    constructor(filename: string);

    pragma(pragma: string): void;
    exec(sql: string): void;
    prepare<TParams = Record<string, unknown>, TResult = unknown>(sql: string): Statement<TParams, TResult>;
    transaction<TArgs extends unknown[] = [], TReturn = void>(
      fn: (...args: TArgs) => TReturn
    ): (...args: TArgs) => TReturn;
    close(): void;
  }

  export default Database;
}
