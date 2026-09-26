-- Factory Phase 1 (foundation): a rolling-window request counter for the public forms (lead
-- capture, newsletter, blog image upload isn't public but shares the primitive) — the routes
-- anyone can POST to without signing in. Ported from Nomad's abuse-guard.ts contract: keyed on a
-- salted hash of the IP (lib/abuse-guard.ts hashes it before this ever sees it, so no raw IP is
-- stored here), fails open (returns true) if this function or table is ever missing, since a spam
-- guard must never be the thing that takes a signup form down.
create table public.rate_limit_hit_log (
  bucket_key text not null,
  hit_at timestamptz not null default now()
);

create index rate_limit_hit_log_bucket_key_hit_at_idx on public.rate_limit_hit_log (bucket_key, hit_at);

alter table public.rate_limit_hit_log enable row level security;

comment on table public.rate_limit_hit_log is 'Factory parity program: backing store for the rate_limit_hit() RPC. Service-role only; rows older than a day are safe to prune, not yet automated.';

-- security definer so the anon/service-role caller doesn't need table-level insert/select grants;
-- the function is the only sanctioned way to touch this table.
create function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.rate_limit_hit_log
  where bucket_key = p_key and hit_at < now() - make_interval(secs => p_window_seconds);

  select count(*) into v_count from public.rate_limit_hit_log where bucket_key = p_key;

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_hit_log (bucket_key) values (p_key);
  return true;
end;
$$;

comment on function public.rate_limit_hit is 'Factory parity program: true while bucket_key is still under p_limit hits in the trailing p_window_seconds; also records this hit when it returns true. Prunes its own old rows on each call rather than needing a separate cron.';
