export * from "./schema";
export * from "./client";

// Re-export the drizzle query operators that consuming apps need.
// This keeps drizzle-orm a single dependency in packages/db rather than
// requiring each app to declare it separately.
export {
  eq,
  and,
  or,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  gt,
  gte,
  lt,
  lte,
  desc,
  asc,
  sql,
} from "drizzle-orm";
