/** Serializable values and storage-checked relational operators. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Operand = { column: string } | { literal: Json };
export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | {
      op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains';
      left: Operand;
      right: Operand;
    };
export type Order = {
  field: string;
  direction?: 'asc' | 'desc';
  collation?: 'binary' | 'natural' | 'key';
};
export type Aggregate =
  | { op: 'count'; field?: string }
  | { op: 'sum' | 'avg' | 'min' | 'max'; field: string };
export type Relation =
  | { op: 'scan'; namespace: string; tableId: string; as: string }
  | { op: 'filter'; input: Relation; predicate: Predicate }
  | { op: 'project'; input: Relation; fields: Record<string, string> }
  | {
      op: 'join';
      left: Relation;
      right: Relation;
      on: { left: string; right: string }[];
      kind: 'inner' | 'left' | 'anti';
    }
  | {
      op: 'group';
      input: Relation;
      by: Record<string, string>;
      aggregates: Record<string, Aggregate>;
    }
  | { op: 'order'; input: Relation; by: Order[] }
  | { op: 'distinct'; input: Relation };
export interface QueryOptions {
  offset?: number;
  limit?: number;
  count?: boolean;
  consistency?: { mode: 'snapshot'; version?: number };
  cursor?: string;
  explain?: boolean;
}
export interface RelationalQuery extends QueryOptions {
  format: 'ink-relational-v1';
  relation: Relation;
}
export interface TableQuery extends QueryOptions {
  where?: Record<
    string,
    | Json
    | {
        eq?: Json;
        ne?: Json;
        gt?: Json;
        gte?: Json;
        lt?: Json;
        lte?: Json;
        in?: Json[];
        contains?: string;
      }
  >;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  select?: string[];
}
export const RELATIONAL_FORMAT: 'ink-relational-v1';
export const relational: Readonly<{
  scan(namespace: string, tableId: string, as?: string): Relation;
  filter(input: Relation, predicate: Predicate): Relation;
  project(input: Relation, fields: Record<string, string>): Relation;
  join(
    left: Relation,
    right: Relation,
    on: { left: string; right: string }[],
    kind?: 'inner' | 'left' | 'anti',
  ): Relation;
  group(
    input: Relation,
    by: Record<string, string>,
    aggregates: Record<string, Aggregate>,
  ): Relation;
  order(input: Relation, by: Order[]): Relation;
  distinct(input: Relation): Relation;
  query(relation: Relation, options?: QueryOptions): RelationalQuery;
}>;
export function column(field: string): Operand;
export function literal(value: Json): Operand;
export function compare(
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains',
  field: string,
  value: Json,
): Predicate;
export function tableQuery(
  namespace: string,
  tableId: string,
  query?: TableQuery,
): RelationalQuery;
