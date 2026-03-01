ALTER TABLE issues ADD COLUMN user_id TEXT;
CREATE INDEX idx_issues_user_id ON issues(user_id);
