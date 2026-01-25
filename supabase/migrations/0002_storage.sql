-- 0002_storage.sql
-- Create bucket + RLS policies for journal screenshots

insert into storage.buckets (id, name, public) values ('journal-screenshots', 'journal-screenshots', false)
on conflict (id) do nothing;

-- Allow authenticated users to read/write only their own files under user_id prefix
create policy "journal screenshots read own" on storage.objects
for select to authenticated
using (
  bucket_id = 'journal-screenshots'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "journal screenshots write own" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'journal-screenshots'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "journal screenshots update own" on storage.objects
for update to authenticated
using (
  bucket_id = 'journal-screenshots'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'journal-screenshots'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "journal screenshots delete own" on storage.objects
for delete to authenticated
using (
  bucket_id = 'journal-screenshots'
  and (storage.foldername(name))[1] = auth.uid()::text
);
