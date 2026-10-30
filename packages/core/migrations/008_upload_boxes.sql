-- The plan screen has four upload boxes; remember which box a file came from.
-- 'source' stays valid for files uploaded before the boxes existed.
ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('source', 'previous_plan', 'assessment', 'graphs', 'other'));
