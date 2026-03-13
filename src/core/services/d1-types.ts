interface D1MetaLike {
  changes: number;
  last_row_id?: number;
}

export interface D1RunResultLike {
  success: boolean;
  meta: D1MetaLike;
}

export interface D1AllResultLike<Row> {
  results: Row[];
  success: boolean;
  meta: D1MetaLike;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<Row>(): Promise<Row | null>;
  all<Row>(): Promise<D1AllResultLike<Row>>;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1RunResultLike[]>;
  exec(query: string): Promise<unknown>;
}
