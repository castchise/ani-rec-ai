// packages/db/src/client.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// For migrations (single connection)
export const migrationClient = postgres(connectionString, { max: 1 });

// For queries (connection pool)
const queryClient = postgres(connectionString);
export const db = drizzle(queryClient, { schema });

export type DB = typeof db;
