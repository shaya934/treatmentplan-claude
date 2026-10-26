-- Section-by-section generation output, streamed to the editor while the job runs.
ALTER TABLE plans ADD COLUMN draft_content jsonb;
