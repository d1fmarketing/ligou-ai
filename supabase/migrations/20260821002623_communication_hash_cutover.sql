alter table public.contact_opt_outs
  add column if not exists hash_algorithm text,
  add column if not exists hash_key_version integer;
alter table public.communications
  add column if not exists hash_algorithm text,
  add column if not exists hash_key_version integer;

update public.contact_opt_outs set hash_algorithm = 'sha256', hash_key_version = null where hash_algorithm is null;
update public.communications set hash_algorithm = 'sha256', hash_key_version = null where hash_algorithm is null;

alter table public.contact_opt_outs
  alter column hash_algorithm set default 'hmac-sha256',
  alter column hash_algorithm set not null,
  alter column hash_key_version set default 1,
  add constraint contact_opt_outs_hash_metadata_check check (
    (hash_algorithm = 'sha256' and hash_key_version is null)
    or (hash_algorithm = 'hmac-sha256' and hash_key_version is not null and hash_key_version > 0));
alter table public.communications
  alter column hash_algorithm set default 'hmac-sha256',
  alter column hash_algorithm set not null,
  alter column hash_key_version set default 1,
  add constraint communications_hash_metadata_check check (
    (hash_algorithm = 'sha256' and hash_key_version is null)
    or (hash_algorithm = 'hmac-sha256' and hash_key_version is not null and hash_key_version > 0));

create index contact_opt_outs_hash_version_lookup on public.contact_opt_outs (tenant_id, hash_algorithm, hash_key_version, contact_hash);
create index communications_hash_version_lookup on public.communications (tenant_id, hash_algorithm, hash_key_version, contact_hash, created_at desc);
