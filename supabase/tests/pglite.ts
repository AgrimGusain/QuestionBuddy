/**
 * An in-process Postgres (PGlite) with every migration applied, plus the
 * small stand-ins for what Supabase provides (auth.uid(), the storage schema,
 * the authenticated role). Lets the SQL functions and RLS be tested without
 * Docker or a real project.
 *
 * PGlite is a single connection: tests can't run two transactions at once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as
      $$ select string_to_array(name, '/') $$;
  `);
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  // What Supabase grants the authenticated role, so RLS is what limits access.
  await db.exec(`
    grant usage on schema public, auth to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant execute on all functions in schema public, auth to authenticated;
  `);
  return db;
}

/** Act as a signed-in user: the authenticated role (RLS applies) with auth.uid() = userId. */
export async function actAs(db: PGlite, userId: string): Promise<void> {
  await db.exec(`reset role`);
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [userId]);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.exec(`set role authenticated`);
}
