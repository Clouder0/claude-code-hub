import "server-only";

import { randomUUID } from "node:crypto";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

type DatabaseLifecycle = "open" | "closing" | "closed";

interface DatabasePoolConfiguration {
  connectionString: string;
  max: number;
  idleTimeout: number;
  connectTimeout: number;
  fetchTypes: false;
}

interface DatabaseState {
  client: postgres.Sql;
  db: Database;
  configuration: DatabasePoolConfiguration;
  instanceId: string;
  lifecycle: DatabaseLifecycle;
  closePromise?: Promise<void>;
}

const DATABASE_STATE_KEY = Symbol.for("claude-code-hub.database-state");

type DatabaseGlobal = typeof globalThis & {
  [DATABASE_STATE_KEY]?: DatabaseState;
};

// Each compiled Next.js bundle gets its own module cache. This local reference is only a fast path;
// the authoritative owner lives on globalThis so all server/SSR bundle copies share one pool.
let localState: DatabaseState | undefined;

function getDatabaseGlobal(): DatabaseGlobal {
  return globalThis as DatabaseGlobal;
}

function resolvePoolConfiguration(): DatabasePoolConfiguration {
  const env = getEnvConfig();
  const connectionString = env.DSN;

  if (!connectionString) {
    throw new Error("DSN environment variable is not set");
  }

  // postgres.js defaults to max=10. Production keeps the existing max=20 default, but the client is
  // process-global so DB_POOL_MAX is now the bound for the whole ordinary application pool.
  const defaultMax = env.NODE_ENV === "production" ? 20 : 10;
  return {
    connectionString,
    max: env.DB_POOL_MAX ?? defaultMax,
    idleTimeout: env.DB_POOL_IDLE_TIMEOUT ?? 20,
    connectTimeout: env.DB_POOL_CONNECT_TIMEOUT ?? 10,
    // postgres.js 3.4.8 can reject both its private array-type discovery query and the held business
    // query when PgBouncer returns a connection-level FATAL. The private rejection has no consumer
    // and reaches process.unhandledRejection. CCH does not use native PostgreSQL array columns, so
    // disable the discovery query and keep operational DB failures inside the awaiting request.
    fetchTypes: false,
  };
}

function getConfigurationDifferences(
  existing: DatabasePoolConfiguration,
  requested: DatabasePoolConfiguration
): string[] {
  const differences: string[] = [];
  if (existing.connectionString !== requested.connectionString) differences.push("DSN");
  if (existing.max !== requested.max) differences.push("DB_POOL_MAX");
  if (existing.idleTimeout !== requested.idleTimeout) differences.push("DB_POOL_IDLE_TIMEOUT");
  if (existing.connectTimeout !== requested.connectTimeout) {
    differences.push("DB_POOL_CONNECT_TIMEOUT");
  }
  if (existing.fetchTypes !== requested.fetchTypes) differences.push("fetch_types");
  return differences;
}

function assertConfigurationMatches(
  state: DatabaseState,
  requested: DatabasePoolConfiguration
): void {
  const differences = getConfigurationDifferences(state.configuration, requested);
  if (differences.length === 0) return;

  logger.error("[Database] process-wide pool configuration conflict", {
    pid: process.pid,
    poolInstanceId: state.instanceId,
    differingFields: differences,
  });
  throw new Error(
    `Database pool configuration conflicts with the existing process-wide client: ${differences.join(", ")}`
  );
}

function assertDatabaseOpen(state: DatabaseState): void {
  if (state.lifecycle !== "open") {
    throw new Error(`Database pool is ${state.lifecycle}; refusing to create or reuse a client`);
  }
}

function createDatabaseState(configuration: DatabasePoolConfiguration): DatabaseState {
  const client = postgres(configuration.connectionString, {
    max: configuration.max,
    idle_timeout: configuration.idleTimeout,
    connect_timeout: configuration.connectTimeout,
    fetch_types: configuration.fetchTypes,
  });
  const state: DatabaseState = {
    client,
    db: drizzle(client, { schema }),
    configuration,
    instanceId: randomUUID(),
    lifecycle: "open",
  };

  logger.info("[Database] process-wide pool created", {
    pid: process.pid,
    poolInstanceId: state.instanceId,
    max: configuration.max,
    idleTimeout: configuration.idleTimeout,
    connectTimeout: configuration.connectTimeout,
    fetchTypes: configuration.fetchTypes,
  });
  return state;
}

function getOrCreateDatabaseState(): DatabaseState {
  if (localState) {
    assertDatabaseOpen(localState);
    return localState;
  }

  const configuration = resolvePoolConfiguration();
  const databaseGlobal = getDatabaseGlobal();
  const existing = databaseGlobal[DATABASE_STATE_KEY];
  if (existing) {
    assertConfigurationMatches(existing, configuration);
    assertDatabaseOpen(existing);
    localState = existing;
    return existing;
  }

  // Construction and publication are synchronous, so another task in this JavaScript realm cannot
  // interleave and create a second client between the check and assignment.
  const state = createDatabaseState(configuration);
  databaseGlobal[DATABASE_STATE_KEY] = state;
  localState = state;
  return state;
}

export function getDb(): Database {
  return getOrCreateDatabaseState().db;
}

export async function closeDatabase(): Promise<void> {
  const state = getDatabaseGlobal()[DATABASE_STATE_KEY];
  if (!state) return;
  if (state.closePromise) return state.closePromise;

  state.lifecycle = "closing";
  state.closePromise = state.client
    // Keep the driver's drain budget below the lifecycle step timeout (3s by default), so the
    // outer containment timer does not report a false timeout at the same instant end() completes.
    .end({ timeout: 2 })
    .then(() => {
      logger.info("[Database] process-wide pool closed", {
        pid: process.pid,
        poolInstanceId: state.instanceId,
      });
    })
    .catch((error: unknown) => {
      logger.warn("[Database] process-wide pool close failed", {
        pid: process.pid,
        poolInstanceId: state.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      state.lifecycle = "closed";
    });

  return state.closePromise;
}

export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, receiver);

    return typeof value === "function" ? value.bind(instance) : value;
  },
});
