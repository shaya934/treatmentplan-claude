-- A file is either a source document for the evidence table, or last period's
-- plan whose content is copied into a reassessment (carried forward).
ALTER TABLE files ADD COLUMN purpose text NOT NULL DEFAULT 'source' CHECK (purpose IN ('source', 'previous_plan'));
