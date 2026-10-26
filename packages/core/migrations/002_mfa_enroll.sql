-- Self-service MFA enrollment (local auth mode): a user may set only their own
-- totp_secret, and nothing else, while app.role = 'mfa_enroll'.
CREATE POLICY users_mfa_enroll ON users FOR UPDATE
  USING (app_role() = 'mfa_enroll' AND id = app_user())
  WITH CHECK (app_role() = 'mfa_enroll' AND id = app_user());

CREATE OR REPLACE FUNCTION users_mfa_enroll_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_role() = 'mfa_enroll' AND (
       NEW.role IS DISTINCT FROM OLD.role OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
       NEW.email IS DISTINCT FROM OLD.email OR NEW.password_hash IS DISTINCT FROM OLD.password_hash OR
       NEW.active IS DISTINCT FROM OLD.active OR NEW.cognito_sub IS DISTINCT FROM OLD.cognito_sub) THEN
    RAISE EXCEPTION 'mfa enrollment may only change totp_secret';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_mfa_enroll_guard_trg BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_mfa_enroll_guard();

-- Users read policy for the enrollment step.
CREATE POLICY users_mfa_enroll_read ON users FOR SELECT USING (app_role() = 'mfa_enroll' AND id = app_user());
