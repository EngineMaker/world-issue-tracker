-- 一覧の並び順 `ORDER BY created_at DESC, id DESC` を支えるインデックス。
--
-- これが無いと SELECT のたびに全表スキャン + TEMP B-TREE でのソートが走る。
-- GET /issues は認証不要の公開エンドポイントで、D1 は読み取り行数で課金されるため、
-- 行数が増えるほど 1 ページあたりのコストが線形に増える。
--
-- id を第 2 キーに含めているのは、created_at が同値の行の順序を確定させる
-- タイブレークもインデックスで解決するため（ソートを完全に省ける）。
CREATE INDEX idx_issues_created_at ON issues(created_at DESC, id DESC);
