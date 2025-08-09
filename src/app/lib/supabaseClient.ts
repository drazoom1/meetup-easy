// src/app/lib/supabaseClient.ts
"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function assertEnv(v: string | undefined, name: string) {
  if (!v || v.trim() === "") {
    throw new Error(
      `${name} is required. 환경변수를 설정하세요: ${name} → .env.local 및 Vercel Project Settings`
    );
  }
}
assertEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
assertEnv(SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 개발 중 HMR로 중복 생성되는 것 방지
const globalForSupabase = globalThis as unknown as { supabase?: SupabaseClient };

export const supabase =
  globalForSupabase.supabase ??
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

if (!globalForSupabase.supabase) globalForSupabase.supabase = supabase;
