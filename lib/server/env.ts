import "server-only";

import { z } from "zod";

const httpUrl = z.string().url().refine(
  (value) => value.startsWith("https://") || value.startsWith("http://"),
  "must use http or https",
);
const postgresUrl = z.string().url().refine(
  (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
  "must use postgres or postgresql",
);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Server configuration is missing: ${name}.`);
  return value;
}

function validated(name: string, schema: z.ZodType<string>): string {
  const result = schema.safeParse(required(name));
  if (!result.success) throw new Error(`Server configuration is invalid: ${name}.`);
  return result.data;
}

export type SupabasePublicConfig = {
  url: string;
  anonKey: string;
};

export function readSupabasePublicConfig(): SupabasePublicConfig {
  return {
    url: validated("NEXT_PUBLIC_SUPABASE_URL", httpUrl),
    anonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  };
}

export function readSupabaseAdminConfig() {
  return {
    ...readSupabasePublicConfig(),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

export function readDatabaseUrl(): string {
  return validated("DATABASE_URL", postgresUrl);
}

export function readServerSecret(
  name: "WORKER_SERVICE_TOKEN" | "INFERENCE_SERVICE_TOKEN" | "CRON_SECRET",
): string {
  return required(name);
}
