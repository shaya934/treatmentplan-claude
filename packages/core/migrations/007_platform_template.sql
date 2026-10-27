-- The platform standard template: what every newly onboarded company starts with.
-- Insert-only versions; the newest is the standard. No row = the built-in template.
CREATE TABLE platform_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL UNIQUE,
  schema_json jsonb NOT NULL,
  change_reason text NOT NULL,
  published_by uuid REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_templates_read ON platform_templates FOR SELECT USING (app_role() IN ('super_admin', 'system'));
CREATE POLICY platform_templates_insert ON platform_templates FOR INSERT WITH CHECK (app_role() = 'super_admin');

GRANT SELECT, INSERT ON platform_templates TO aba_app;
