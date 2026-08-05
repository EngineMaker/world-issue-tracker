-- Issue に対するコメント。
--
-- `id` は issues と同じく `lower(hex(randomblob(16)))` のランダム値。
-- 一覧の並び順を確定させるため `created_at` と組で使う（issues と同じ方式）。
--
-- `issue_id` に外部キーを張って、存在しない Issue へのコメントを DB 側でも止める。
-- `ON DELETE CASCADE` にしているのは、Issue が消えたときにコメントだけが
-- どこからも辿れない孤児として残るのを防ぐため。
-- ただし D1 は接続ごとに `PRAGMA foreign_keys` の状態が変わりうるので、
-- 参照先の存在確認はアプリ側（`POST /issues/:id/comments`）でも行う。
--
-- `user_id` は Clerk の User ID。issues とは違い NOT NULL にしている。
-- 投稿は認証必須で、匿名コメントを受ける経路が無いため。
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `GET /issues/:id/comments` は `WHERE issue_id = ? ORDER BY created_at ASC, id ASC` で引く。
-- 認証不要の公開エンドポイントであり、D1 は読み取り行数で課金されるため、
-- 絞り込みと並び替えの両方をインデックスで解決できる形にしておく。
CREATE INDEX idx_comments_issue_id_created_at ON comments(issue_id, created_at, id);
