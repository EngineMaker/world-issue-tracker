-- 「手伝います」の表明（help offer）。
--
-- Issue を「可視化」から「解決に向けて動かす」ための最小の装置。
-- 1 ユーザーが 1 Issue に対して表明しているかどうか、という真偽値しか持たない。
-- コメント本文のような付帯情報が要るなら comments 側（#60）に載る。
CREATE TABLE IF NOT EXISTS help_offers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  -- Clerk の User ID。issues.user_id と同じく外部の識別子で、こちらには実体が無い。
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- 同一ユーザーが同じ Issue に二重に表明できないようにする。
  -- アプリ側でも INSERT 前に存在確認はするが、確認と挿入の間に別リクエストが
  -- 割り込めば二重に入りうる。件数が実際より多く見えると「何人が動けるか」という
  -- この機能の唯一の情報が壊れるため、DB 側の制約で最終的に担保する。
  UNIQUE (issue_id, user_id)
);

-- Issue 詳細を開くたびに `WHERE issue_id = ?` で表明を引くため、その分の索引。
-- UNIQUE (issue_id, user_id) が張る索引の先頭列が issue_id なので、
-- 件数の集計と一覧の取得はそちらで賄える。ここでは重複する索引を足さない。

-- 「自分が表明した Issue」を引く経路（マイページ等）に備える。
-- UNIQUE 索引は issue_id が先頭なので user_id 単独の検索には効かない。
CREATE INDEX idx_help_offers_user_id ON help_offers(user_id);
