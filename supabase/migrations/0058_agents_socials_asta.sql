-- Social links and ASTA membership on the agents roster.
--
-- social_links: a list of {kind, label, url, public}. kind is facebook_profile, facebook_page, facebook_group, instagram,
-- tiktok, youtube, linkedin, x, pinterest, website or other. EVERY link is private until the owner presses "Make public" on that
-- one link in the Agents admin screen (public = true). Imports and agent self-service can never set public = true.
--
-- ASTA: asta_member is the claim, asta_number is private (admin only, never selected by public code), asta_verified is the owner
-- ticking that he checked it. The public page shows "ASTA member" only when asta_member AND asta_verified are both true.
--
-- agents already has RLS on with no policies (migration 0054); public code reads through the service role with an explicit
-- column list, and the public mapper drops every link that is not public = true.
--
-- Safe to run on a table with data: columns are added only if missing; everyone starts with no links and not an ASTA member.

alter table public.agents add column if not exists social_links jsonb not null default '[]'::jsonb;
alter table public.agents add column if not exists asta_member boolean not null default false;
alter table public.agents add column if not exists asta_number text;
alter table public.agents add column if not exists asta_verified boolean not null default false;
