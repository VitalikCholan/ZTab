-- A participant row must carry its index; admin and group rows must not.
ALTER TABLE "tab_tokens" ADD CONSTRAINT "tab_tokens_participant_index_check"
  CHECK (("role" = 'participant') = ("index" IS NOT NULL));
ALTER TABLE "tab_blobs" ADD CONSTRAINT "tab_blobs_participant_index_check"
  CHECK (("role" = 'participant') = ("index" IS NOT NULL));
