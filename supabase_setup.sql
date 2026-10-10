-- Журнал сетапов · v1.0 · настройка Supabase
-- Запуск: Supabase → SQL Editor → New query → вставить всё → Run. Можно запускать повторно.

-- ===== ТАБЛИЦЫ =====
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null default '',
  folder_id uuid references public.folders(id) on delete set null, -- null = «Не отсортированные»
  status text not null default 'none' check (status in ('none','success','fail')),
  comment text not null default '',
  is_favorite boolean not null default false,
  hash text,                       -- SHA-256 файла. Индекс обычный, НЕ уникальный (дубли разрешены)
  width int,
  height int,
  size bigint,
  original_path text not null,
  preview_path text
);

create table if not exists public.image_tags (
  image_id uuid not null references public.images(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (image_id, tag_id)
);

create index if not exists images_hash_idx on public.images (hash);
create index if not exists images_title_idx on public.images (title);
create index if not exists images_folder_idx on public.images (folder_id, created_at desc);

-- ===== ДОСТУП: только залогиненный пользователь =====
grant select, insert, update, delete on public.folders, public.tags, public.images, public.image_tags to authenticated;

alter table public.folders enable row level security;
alter table public.tags enable row level security;
alter table public.images enable row level security;
alter table public.image_tags enable row level security;

drop policy if exists "auth_all" on public.folders;
create policy "auth_all" on public.folders for all to authenticated using (true) with check (true);
drop policy if exists "auth_all" on public.tags;
create policy "auth_all" on public.tags for all to authenticated using (true) with check (true);
drop policy if exists "auth_all" on public.images;
create policy "auth_all" on public.images for all to authenticated using (true) with check (true);
drop policy if exists "auth_all" on public.image_tags;
create policy "auth_all" on public.image_tags for all to authenticated using (true) with check (true);

-- ===== ПРИВАТНОЕ ХРАНИЛИЩЕ КАРТИНОК =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('charts', 'charts', false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/png','image/jpeg','image/webp'];

drop policy if exists "charts_auth_all" on storage.objects;
create policy "charts_auth_all" on storage.objects for all to authenticated
  using (bucket_id = 'charts') with check (bucket_id = 'charts');
