-- Privacy-by-design: drop Session.ipAddress + Session.userAgent.
--
-- Both columns were declared in the original Session model but the
-- auth service never populated them (all 21 existing rows had both as
-- NULL — verified before this drop). They were an aspirational
-- "future audit trail" that never shipped.
--
-- Keeping unpopulated columns isn't free: every schema introspection
-- + DTO mapping still surfaces them, the Privacy Policy has to
-- disclose them (the law cares about what you CAN collect, not just
-- what you DO), and they create temptation to start writing IPs
-- later "because the column exists". Cleanest fix is to drop them.
--
-- We still capture client IPs at the reverse-proxy layer (Caddy
-- access logs, rotated by file size — 5 × 50 MB). That's enough for
-- abuse mitigation; we don't need a second copy in the database tied
-- to the user's account.

ALTER TABLE "sessions" DROP COLUMN IF EXISTS "userAgent";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "ipAddress";
