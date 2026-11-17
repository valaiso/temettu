-- Temettü sitesinin portföy verisi (hisseler, adet geçmişi) cihazlar arasında eşitlensin diye
-- her kullanıcı için tek satır tutulur. Supabase → SQL Editor'de bir kez çalıştır.
create table if not exists public.temettu_state (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.temettu_state enable row level security;

-- Kullanıcı yalnızca kendi satırını görür ve değiştirir.
drop policy if exists "kendi verisi okunur" on public.temettu_state;
create policy "kendi verisi okunur" on public.temettu_state
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "kendi verisi eklenir" on public.temettu_state;
create policy "kendi verisi eklenir" on public.temettu_state
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "kendi verisi guncellenir" on public.temettu_state;
create policy "kendi verisi guncellenir" on public.temettu_state
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
