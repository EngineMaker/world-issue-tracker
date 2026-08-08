-- Issue に添付する写真（#65）。
--
-- 画像の実体は R2（バインディング `PHOTOS`）に置き、ここにはその
-- オブジェクトキーだけを持つ。画像を DB に入れない理由は、D1 の
-- 行サイズ制限（1 行あたり 2MB）に 5MB の写真が収まらないことと、
-- 一覧の SELECT が画像のバイト列まで読んでしまうため。
--
-- 写真は必須ではない（その場で撮れないこともある）ので NULL 許容。
-- NULL のときは画面側が地図（#63）を代役として出す。
ALTER TABLE issues ADD COLUMN photo_key TEXT;

-- 画像の MIME タイプ。配信時（`GET /issues/:id/photo`）の
-- `Content-Type` に使う。
--
-- R2 のオブジェクトメタデータにも同じ値が入るが、そちらを読むには
-- R2 への往復が要る。詳細ページは Issue の行を必ず読むので、行に
-- 持たせておけば「画像があるか」「何を返すか」を 1 回の SELECT で判断できる。
--
-- photo_key が NULL の行ではこちらも NULL。両方が揃っているか
-- 両方とも NULL かのどちらかで、片方だけが入ることはアプリ側が保証する。
ALTER TABLE issues ADD COLUMN photo_content_type TEXT;
