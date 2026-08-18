-- 位置情報を任意にし、保存する座標を丸める（#124）。
--
-- 本番の利用者から「場所を特定されると嫌なので、位置情報を丸めるか
-- 必須じゃないようにしてほしい」という要望が**匿名で**寄せられた。
-- そのとき API から取れた座標は小数点以下 13 桁で、緯度の 1e-13 度は
-- ミリメートル未満の分解能。名前を伏せても、自宅の敷地内のどこかまで
-- 誰でも指せる状態だった。#88 の匿名の選択が、位置情報の外側にあった。
--
-- このマイグレーションがやることは 2 つ。
--
--  1. `latitude` / `longitude` の NOT NULL を外す（位置なしの起票を許す）
--  2. **既存行の座標を小数点以下 3 桁へ丸める**（約 100m）
--
-- 2 が要るのは、保存時に丸める方式（`src/routes/issues.ts`）を選んだため。
-- これから入る行は丸まるが、**すでに入っている行は細かいまま残る**。
-- 公開時にだけ丸める方式なら移行は不要だが、それだと細かい値が DB に
-- 残り続け、管理用の SQL・将来足すエンドポイント・バックアップの流出
-- といった別経路から出うる。持たないのが一番強いので、ここで消す。
--
-- **丸めは不可逆で、元の桁は復元できない。** それが目的なので意図どおり。
-- 地図としての用途（どのあたりに何が集まっているか）は 3 桁で保たれる。
--
-- 丸める対象を匿名の行に限っていないのは、匿名と記名を後から切り替える
-- 機能が入った瞬間に穴が空くため（記名で保存した細かい座標が、匿名へ
-- 変えても残る）。名前を出すことと、自宅を指されることは別の話でもある。
--
-- SQLite は `ALTER TABLE` で NOT NULL を外せないため、テーブルを作り直す。
-- 手順は SQLite / D1 の定石どおり「新テーブル → コピー → 差し替え」。
--
-- `defer_foreign_keys` を立てているのは、`comments` / `help_offers` /
-- `reactions` が `REFERENCES issues(id) ON DELETE CASCADE` を持つため。
-- `DROP TABLE issues` の時点で参照先が一時的に消えるので、外部キーの
-- 検査をこのトランザクションの終わりまで遅らせる。`ALTER TABLE ... RENAME`
-- で `issues` が戻った時点で参照は元通りになる（参照している側の
-- REFERENCES 句は名前で解決されるため、書き換えは要らない）。
PRAGMA defer_foreign_keys = TRUE;

-- カラムの並びは**現在のテーブルと同じ順**にする。`0002` / `0007` / `0008`
-- の `ALTER TABLE ADD COLUMN` で後ろに足された 4 つは、ここでも末尾に置く。
-- 並べ替えると `SELECT *` の結果の順序が変わり、カラム順を固定している
-- テスト（`test/schema.test.ts`）も落ちる。作り直しは制約を変えるための
-- 手段であって、スキーマの見た目を整える機会ではない。
--
-- 制約と既定値は元のまま写す。`scope` / `status` の CHECK は
-- `packages/shared` の enum と手で同期している（`test/schema.test.ts` が
-- 一致を検証する）ので、ここで値を書き換えないこと。
CREATE TABLE issues_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'community', 'municipality', 'national', 'global')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'in_progress', 'review', 'resolved', 'closed')),
  latitude REAL,
  longitude REAL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id TEXT,
  photo_key TEXT,
  photo_content_type TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 1
);

-- 座標だけを `ROUND(..., 3)` で丸めて写す。他の列は素通し。
--
-- `updated_at` は動かさない。これは利用者が Issue を更新したのではなく、
-- 保存している値の精度をこちらの都合で落としただけなので、「最終更新」が
-- 全件このマイグレーションの時刻に揃うと、一覧の並びも意味を失う。
--
-- `ROUND` は NULL に対して NULL を返すので、位置なしの行（このあと
-- 作られる分）を通しても壊れない。
INSERT INTO issues_new (
  id, title, description, scope, status, latitude, longitude, category,
  created_at, updated_at, user_id, photo_key, photo_content_type, is_anonymous
)
SELECT
  id, title, description, scope, status,
  ROUND(latitude, 3), ROUND(longitude, 3),
  category, created_at, updated_at, user_id, photo_key, photo_content_type, is_anonymous
FROM issues;

DROP TABLE issues;

ALTER TABLE issues_new RENAME TO issues;

-- インデックスは作り直す。`DROP TABLE` で元のテーブルと一緒に消えるため、
-- ここで作らないと 6 本すべてが失われる（一覧の並び順もカーソルページングも
-- 全行走査になる）。定義は `0001` / `0002` / `0003` / `0004` のものと同じで、
-- `test/schema.test.ts` が「マイグレーションが定義するインデックスが全部ある」
-- ことを見張っている。
CREATE INDEX idx_issues_scope ON issues(scope);
CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_location ON issues(latitude, longitude);
CREATE INDEX idx_issues_user_id ON issues(user_id);
CREATE INDEX idx_issues_created_at ON issues(created_at DESC, id DESC);
CREATE INDEX idx_issues_user_id_created_at ON issues(user_id, created_at DESC, id DESC);
