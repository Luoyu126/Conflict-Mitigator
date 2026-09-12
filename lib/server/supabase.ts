import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseAdminConfig, readSupabasePublicConfig } from "./env.ts";

const options = {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
} as const;

let authClient: SupabaseClient | undefined;
let adminClient: SupabaseClient | undefined;

export function getSupabaseAuthClient(): SupabaseClient {
  if (!authClient) {
    const config = readSupabasePublicConfig();
    authClient = createClient(config.url, config.anonKey, options);
  }
  return authClient;
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (!adminClient) {
    const config = readSupabaseAdminConfig();
    adminClient = createClient(config.url, config.serviceRoleKey, options);
  }
  return adminClient;
}
