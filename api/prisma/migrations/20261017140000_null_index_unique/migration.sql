-- Admin and group rows carry a NULL index, and plain UNIQUE treats NULLs as
-- distinct, so (tab_id, role, index) would not stop a second admin or group
-- row. Rebuild the unique indexes with NULLS NOT DISTINCT (PostgreSQL 15+).
-- The index names match Prisma's @@unique defaults.
DROP INDEX "tab_blobs_tab_id_role_index_key";
CREATE UNIQUE INDEX "tab_blobs_tab_id_role_index_key"
  ON "tab_blobs"("tab_id", "role", "index") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "tab_tokens_tab_id_role_index_key"
  ON "tab_tokens"("tab_id", "role", "index") NULLS NOT DISTINCT;
