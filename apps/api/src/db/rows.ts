import type { IssueScope, IssueStatus } from "@world-issue-tracker/shared";

/**
 * DB のテーブル 1 行に対応する型。
 *
 * ここに書くのは「DB が実際に返す姿」であって、API が返してよい姿ではない。
 * 内部フィールド（`user_id` など）も含める。公開してよい形は各ルーターの
 * `Public*Columns` 側で `Pick` して導く（`routes/issues.ts` ほか）。
 *
 * `apps/api` に閉じて置いている。`packages/shared` に出すと `apps/web` からも
 * DB の内部構造が見えてしまい、公開してよい形との区別が曖昧になる。
 *
 * 型注釈は嘘をつけるので、`migrations/*.sql` の定義と 1 対 1 で突き合わせて書く。
 * SQLite の型は緩いが、D1 は `REAL` を number、`TEXT` を string として返すため
 * そのまま対応させる。NULL を許すカラムには `| null` を付ける。
 *
 * ここでコンパイラが後から守ってくれる範囲には限りがある。カラム「名」の誤りは
 * 使う側（`Pick` やプロパティ参照）で検出できるが、値の「型」を書き間違えても
 * 誰も気づかない。`.first<T>()` は D1 から返る値を無検査で `T` として扱うだけで、
 * 実際の値と突き合わせる機構が無いため。`string` と `number` の取り違えや
 * `| null` の付け忘れは、この型を書いた時点で正しいかどうかが決まる。
 * カラムを足すときは migrations を開いて確かめること。
 */

/**
 * `issues` テーブルの 1 行（`0001_initial.sql` / `0002_add_user_id.sql`）。
 *
 * `scope` / `status` は CHECK 制約で値が固定されているため、
 * `packages/shared` の enum をそのまま当てる。制約の値と enum の値が
 * ずれたらそこが嘘になるが、両者が一致していることは `test/schema.test.ts`
 * が検証している。
 *
 * `category` と `user_id` は NULL を許す。`user_id` は Clerk 導入前に
 * 入った行が NULL を持つ（`0002` で後から足したカラムなので DEFAULT も無い）。
 */
export type IssueRow = {
	id: string;
	title: string;
	description: string;
	scope: IssueScope;
	status: IssueStatus;
	latitude: number;
	longitude: number;
	category: string | null;
	user_id: string | null;
	created_at: string;
	updated_at: string;
};

/**
 * `comments` テーブルの 1 行（`0005_create_comments.sql`）。
 *
 * `user_id` は `issues` と違い NOT NULL。投稿が認証必須で、
 * 匿名コメントを受ける経路が無いため（マイグレーションのコメント参照）。
 */
export type CommentRow = {
	id: string;
	issue_id: string;
	user_id: string;
	body: string;
	created_at: string;
};

/**
 * `help_offers` テーブルの 1 行（`0006_create_help_offers.sql`）。
 *
 * 真偽値としての「表明したか」しか持たないので、付帯情報の列は無い。
 */
export type HelpOfferRow = {
	id: string;
	issue_id: string;
	user_id: string;
	created_at: string;
};
