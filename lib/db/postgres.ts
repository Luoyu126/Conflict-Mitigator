import "server-only";

import postgres from "postgres";
import { readDatabaseUrl } from "../server/env.ts";

export type DatabaseClient = postgres.Sql;
export type TransactionClient = postgres.TransactionSql;
export type DatabaseExecutor = DatabaseClient | TransactionClient;

let database: DatabaseClient | undefined;

export function getDatabase(): DatabaseClient {
  if (!database) {
    database = postgres(readDatabaseUrl(), {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => undefined,
    });
  }
  return database;
}

export async function withTransaction<T>(
  callback: (transaction: TransactionClient) => Promise<T>,
): Promise<T> {
  const wrapped = await getDatabase().begin(async (transaction) => ({
    value: await callback(transaction),
  }));
  return wrapped.value;
}

export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.end({ timeout: 5 });
    database = undefined;
  }
}
