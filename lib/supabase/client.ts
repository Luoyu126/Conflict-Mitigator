"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;

export function getBrowserSupabase(): SupabaseClient {
  if (!browserClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error("Public Supabase configuration is missing.");
    browserClient = createBrowserClient(url, anonKey);
  }
  return browserClient;
}

/** Establishes the anonymous Supabase identity used by every browser API call. */
async function loadAnonymousSession(): Promise<string> {
  const client = getBrowserSupabase();
  const { data: { session: existingSession }, error } = await client.auth.getSession();
  if (error) throw error;
  let session = existingSession;
  if (!session) {
    const signedIn = await client.auth.signInAnonymously();
    if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("Anonymous sign-in failed.");
    session = signedIn.data.session;
  }
  return session.access_token;
}

let establishingSession: Promise<string> | undefined;
export function ensureAnonymousSession(): Promise<string> {
  if (!establishingSession) establishingSession = loadAnonymousSession().finally(() => { establishingSession = undefined; });
  return establishingSession;
}
