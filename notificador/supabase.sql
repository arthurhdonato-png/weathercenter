-- WeatherCenter: banco das inscrições de notificações (Supabase, plano grátis).
-- Como usar: Supabase > SQL Editor > New query > cole TUDO isto > Run.
-- Pode rodar de novo sem problema (não apaga inscrições existentes).
--
-- Segurança:
-- - As tabelas ficam fechadas (RLS ligado e sem regras): a chave pública do app NÃO lê nem altera nada direto.
-- - O app só consegue chamar as funções wc_inscrever e wc_cancelar, que validam tudo o que recebem.
-- - Só o GitHub Actions, com a chave secreta (GitHub Secrets), lê as inscrições para enviar os avisos.

create table if not exists public.wc_inscricoes (
  endpoint      text primary key,
  p256dh        text not null,
  auth          text not null,
  cidades       jsonb not null default '[]'::jsonb,
  nivel_min     smallint not null default 1 check (nivel_min between 1 and 3),
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Alertas já avisados (para não repetir a mesma notificação a cada 5 minutos)
create table if not exists public.wc_enviados (
  chave      text primary key,
  enviado_em timestamptz not null default now()
);

alter table public.wc_inscricoes enable row level security;
alter table public.wc_enviados enable row level security;
revoke all on public.wc_inscricoes, public.wc_enviados from anon, authenticated;

-- Guarda (ou atualiza) a inscrição de um aparelho com as cidades escolhidas.
-- Lista de cidades vazia = cancelar.
create or replace function public.wc_inscrever(
  p_endpoint text, p_p256dh text, p_auth text, p_cidades jsonb, p_nivel_min int default 1
) returns void
language plpgsql security definer set search_path = public as $$
declare
  limpas jsonb;
  validas int;
begin
  -- Só serviços de push conhecidos (Google/Chrome, Mozilla/Firefox, Apple/Safari, Microsoft/Edge)
  if p_endpoint is null or length(p_endpoint) > 1000 or p_endpoint !~
     '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/' then
    raise exception 'endereço de push não aceito';
  end if;
  if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{86,88}={0,2}$' then raise exception 'chave p256dh inválida'; end if;
  if p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{20,24}={0,2}$' then raise exception 'chave auth inválida'; end if;
  if p_nivel_min is null or p_nivel_min not between 1 and 3 then raise exception 'nível inválido'; end if;
  if p_cidades is null or jsonb_typeof(p_cidades) <> 'array' or jsonb_array_length(p_cidades) > 10 then
    raise exception 'lista de cidades inválida (máximo 10)';
  end if;

  -- Cada cidade: código IBGE (7 dígitos) e/ou coordenadas dentro do Brasil
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'id',   c->>'id',
           'nome', left(coalesce(c->>'nome', ''), 80),
           'uf',   left(coalesce(c->>'uf', ''), 2),
           'lat',  round((c->>'lat')::numeric, 4),
           'lon',  round((c->>'lon')::numeric, 4))), '[]'::jsonb)
    into validas, limpas
    from jsonb_array_elements(p_cidades) c
   where jsonb_typeof(c) = 'object'
     and (c->>'id' is null or c->>'id' ~ '^\d{7}$')
     and jsonb_typeof(c->'lat') = 'number' and jsonb_typeof(c->'lon') = 'number'
     and (c->>'lat')::numeric between -35 and 7
     and (c->>'lon')::numeric between -75 and -28;
  if validas <> jsonb_array_length(p_cidades) then raise exception 'cidade inválida'; end if;

  if validas = 0 then
    delete from wc_inscricoes where endpoint = p_endpoint;
    return;
  end if;

  insert into wc_inscricoes (endpoint, p256dh, auth, cidades, nivel_min)
  values (p_endpoint, p_p256dh, p_auth, limpas, p_nivel_min)
  on conflict (endpoint) do update
     set p256dh = excluded.p256dh, auth = excluded.auth, cidades = excluded.cidades,
         nivel_min = excluded.nivel_min, atualizado_em = now();
end $$;

create or replace function public.wc_cancelar(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from wc_inscricoes where endpoint = p_endpoint;
$$;

revoke all on function public.wc_inscrever(text, text, text, jsonb, int) from public;
revoke all on function public.wc_cancelar(text) from public;
grant execute on function public.wc_inscrever(text, text, text, jsonb, int) to anon, authenticated;
grant execute on function public.wc_cancelar(text) to anon, authenticated;
