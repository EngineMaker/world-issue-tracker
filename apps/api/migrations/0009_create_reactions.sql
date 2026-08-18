-- 「私も困っている」の表明（reaction）。
--
-- 読んだだけの人が意思表示する手段（#112）。コメント（#60）は文章を書く必要があり、
-- 「手伝います」（#61）は自分が動く約束になる。その間に何も無かったため、
-- 共感しただけの人の声が拾えていなかった。
--
-- help_offers と形は同じだが、意味が違う。あちらは「動く人」の表明で、
-- こちらは「困っている人」の表明。1 ユーザーが 1 Issue に対して表明しているか
-- どうか、という真偽値しか持たない点だけが共通している。
--
-- 種類は 1 つに絞っている（列も持たない）。種類を増やすと「どれを押すべきか」
-- という判断が発生し、意思表示の心理的コストを下げるというこの機能の目的と
-- 逆行するため。
CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  -- Clerk の User ID。issues.user_id と同じく外部の識別子で、こちらには実体が無い。
  --
  -- help_offers と違い、この値は公開レスポンスに載せない
  -- （`routes/reactions.ts` の `PUBLIC_REACTION_COLUMNS` 参照）。
  -- 「私も困っている」は生活圏の露出につながりえるため、数だけを出す。
  -- 二重に押せないことを担保するためだけに持っている。
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- 同一ユーザーが同じ Issue に二重に表明できないようにする。
  -- アプリ側でも INSERT 前に存在確認はするが、確認と挿入の間に別リクエストが
  -- 割り込めば二重に入りうる。件数が実際より多く見えると「何人が困っているか」という
  -- この機能の唯一の情報が壊れるため、DB 側の制約で最終的に担保する。
  UNIQUE (issue_id, user_id)
);

-- Issue 詳細と一覧の両方で `WHERE issue_id = ?` の集計を引くが、
-- UNIQUE (issue_id, user_id) が張る索引の先頭列が issue_id なので、
-- 件数の集計はそちらで賄える。ここでは重複する索引を足さない。

-- 「自分が反応した Issue」を引く経路（マイページ等）に備える。
-- UNIQUE 索引は issue_id が先頭なので user_id 単独の検索には効かない。
CREATE INDEX idx_reactions_user_id ON reactions(user_id);
