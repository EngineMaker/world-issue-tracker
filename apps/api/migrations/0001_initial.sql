CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'community', 'municipality', 'national', 'global')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'in_progress', 'review', 'resolved', 'closed')),
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_issues_scope ON issues(scope);
CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_location ON issues(latitude, longitude);
