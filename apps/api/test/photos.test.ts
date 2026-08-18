import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `@hono/clerk-auth` ではなく、その内部が使う `@clerk/backend` をモックする。
// 詳細は helpers/clerk-mock.ts。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { ISSUE_THUMBNAIL_MAX_BYTES } from "@world-issue-tracker/shared";
import { createApp } from "../src/index";
import { photoObjectKey, photoThumbnailObjectKey } from "../src/routes/issues";
import { setMockUserId } from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

const app = createApp();

/**
 * 注意: `GET /issues/:id/photo` のレスポンスは、ステータスやヘッダしか
 * 見ない場合でもボディを読み切ること（`await res.arrayBuffer()`）。
 *
 * 配信は R2 のオブジェクトを `Response` にストリームで載せて返しており、
 * 読まずにテストを終えるとハンドルが開いたまま残る。
 * `@cloudflare/vitest-pool-workers` のテスト間ストレージ分離はテストの
 * 終了時に R2 のストレージを畳むため、そこで
 * 「Failed to pop isolated storage stack frame」を出して失敗する。
 * 落ちるのは読み残したテストとは限らず、原因から離れた場所に出る。
 */

/** 書き込み系は Origin 検証を通す必要がある（`csrf.test.ts` 参照）。 */
const ALLOWED_ORIGIN = "http://localhost:3000";

const OWNER_USER_ID = "test-user-123";

const validIssue = {
	title: "Broken streetlight",
	description: "The streetlight on Main St is not working",
	scope: "community",
	latitude: 35.68,
	longitude: 139.76,
};

// biome-ignore lint/suspicious/noExplicitAny: テストからレスポンスを緩く読むための意図的な型
type IssueBody = Record<string, any>;

async function readBody(res: Response): Promise<IssueBody> {
	return (await res.json()) as IssueBody;
}

/**
 * 画像として送るバイト列を作る。
 *
 * 中身は検証していない（マジックバイトの検査は #65 の範囲外）ので、
 * サイズが意図どおりであることだけが重要。バイトの内容を固定値ではなく
 * 位置由来にしているのは、保存されたバイト列が「同じ長さの別のもの」に
 * すり替わっていないことを往復で確かめられるようにするため。
 */
function imageBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		bytes[i] = i % 256;
	}
	return bytes;
}

/**
 * 写真付きで起票する。
 *
 * `multipart/form-data` の組み立ては `FormData` に任せる（境界文字列を
 * 手で書くと、実装が受け取れる形かどうかがテスト側の書き方に依存する）。
 * `Content-Type` は明示せず、`fetch` が境界付きで補うのに任せる。
 */
async function createIssueWithPhoto(
	photo: { bytes: Uint8Array; type: string; name?: string } | null,
	fields: Record<string, string> = {},
	// 一覧用のサムネイル（#125）。ブラウザが原寸と一緒に送ってくる派生物
	thumbnail: { bytes: Uint8Array; type: string; name?: string } | null = null,
): Promise<Response> {
	const form = new FormData();
	form.set("title", fields.title ?? validIssue.title);
	form.set("description", fields.description ?? validIssue.description);
	form.set("scope", fields.scope ?? validIssue.scope);
	form.set("latitude", fields.latitude ?? String(validIssue.latitude));
	form.set("longitude", fields.longitude ?? String(validIssue.longitude));
	if (fields.category !== undefined) {
		form.set("category", fields.category);
	}
	if (photo) {
		form.set(
			"photo",
			new Blob([photo.bytes], { type: photo.type }),
			photo.name ?? "photo.jpg",
		);
	}
	if (thumbnail) {
		form.set(
			"thumbnail",
			new Blob([thumbnail.bytes], { type: thumbnail.type }),
			thumbnail.name ?? "thumbnail.jpg",
		);
	}

	return app.request(
		"/issues",
		{ method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: form },
		env,
	);
}

/** JSON（写真なし）で起票する。既存クライアントの経路。 */
async function createIssueAsJson(): Promise<Response> {
	return app.request(
		"/issues",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
			body: JSON.stringify(validIssue),
		},
		env,
	);
}

/** DB の行を直接読む。レスポンスだけを見ていると永続化を確認できない。 */
async function readStoredIssue(id: string): Promise<IssueBody> {
	const row = await env.DB.prepare("SELECT * FROM issues WHERE id = ?")
		.bind(id)
		.first<IssueBody>();
	if (!row) {
		throw new Error(`issue ${id} not found`);
	}
	return row;
}

async function countIssues(): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) as total FROM issues",
	).first<{ total: number }>();
	return row?.total ?? 0;
}

/** R2 に置かれたオブジェクトの数。孤児ファイルが残っていないことの確認に使う。 */
async function countPhotoObjects(): Promise<number> {
	const listed = await env.PHOTOS.list();
	return listed.objects.length;
}

describe("Issue photos", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM issues");
		// R2 はテスト間で状態が残る。前のテストが置いた画像を消しておかないと
		// 「孤児ファイルが無いこと」を数で確かめられない
		const listed = await env.PHOTOS.list();
		await Promise.all(
			listed.objects.map((object) => env.PHOTOS.delete(object.key)),
		);
		setMockUserId(OWNER_USER_ID);
	});

	describe("POST /issues with a photo", () => {
		it("stores the photo in R2 and records it on the issue", async () => {
			const bytes = imageBytes(1024);
			const res = await createIssueWithPhoto({
				bytes,
				type: "image/jpeg",
			});

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.has_photo).toBe(true);

			// 行に記録されていること。レスポンスだけを組み立てる実装では通らない
			const stored = await readStoredIssue(body.id);
			expect(stored.photo_key).toBe(photoObjectKey(body.id));
			expect(stored.photo_content_type).toBe("image/jpeg");

			// R2 に置かれた中身が送ったバイト列と一致すること。
			// 長さだけを見ると、別の同じ長さのものに化けていても気づけない
			const object = await env.PHOTOS.get(String(stored.photo_key));
			expect(object).not.toBeNull();
			const savedBytes = new Uint8Array(
				await (object as R2ObjectBody).arrayBuffer(),
			);
			expect(savedBytes).toEqual(bytes);
		});

		it("keeps the other fields intact when a photo is attached", async () => {
			// multipart 経路でも本文のフィールドが正しく届いていること。
			// 写真だけを見ていると、title が空文字で保存される退行に気づけない
			const res = await createIssueWithPhoto(
				{ bytes: imageBytes(64), type: "image/png" },
				{ category: "防犯・安全" },
			);

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.title).toBe(validIssue.title);
			expect(body.description).toBe(validIssue.description);
			expect(body.scope).toBe(validIssue.scope);
			expect(body.latitude).toBe(validIssue.latitude);
			expect(body.longitude).toBe(validIssue.longitude);
			expect(body.category).toBe("防犯・安全");
			expect(body.status).toBe("open");
		});

		// 写真は必須ではない（その場で撮れないこともある、#65）。
		// multipart で送っておきながら写真パートが無い形も通ること。
		it("creates an issue without a photo over multipart", async () => {
			const res = await createIssueWithPhoto(null);

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.has_photo).toBe(false);

			const stored = await readStoredIssue(body.id);
			expect(stored.photo_key).toBeNull();
			expect(await countPhotoObjects()).toBe(0);
		});

		// ファイルを選ばずに送信すると、ブラウザが空のファイルパートを
		// 付けることがある。中身の無い画像を保存してはいけない
		it("treats an empty file part as no photo", async () => {
			const res = await createIssueWithPhoto({
				bytes: new Uint8Array(0),
				type: "image/jpeg",
			});

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.has_photo).toBe(false);
			expect(await countPhotoObjects()).toBe(0);
		});

		// 既存クライアント（JSON で投げる）を壊していないこと。
		// multipart 対応が JSON 経路を巻き込んで壊すのが一番ありがちな退行
		it("still accepts a JSON body without a photo", async () => {
			const res = await createIssueAsJson();

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.has_photo).toBe(false);
			expect(body.title).toBe(validIssue.title);
		});

		it("requires authentication", async () => {
			setMockUserId(null);
			const res = await createIssueWithPhoto({
				bytes: imageBytes(64),
				type: "image/jpeg",
			});

			expect(res.status).toBe(401);
			// 認証で弾いた以上、副作用は一切残ってはいけない。
			// ステータスだけを見ていると「401 を返すが保存はする」実装を見逃す
			expect(await countIssues()).toBe(0);
			expect(await countPhotoObjects()).toBe(0);
		});

		it("validates the body fields sent as multipart", async () => {
			const res = await createIssueWithPhoto(
				{ bytes: imageBytes(64), type: "image/jpeg" },
				{ title: "" },
			);

			expect(res.status).toBe(400);
			expect(await countIssues()).toBe(0);
			expect(await countPhotoObjects()).toBe(0);
		});

		// 空文字の緯度が `Number("")` で 0 に化けると、赤道上の Issue が
		// 黙って作られる。「未入力」として弾かれること
		it("rejects a blank latitude instead of coercing it to 0", async () => {
			const res = await createIssueWithPhoto(null, { latitude: "" });

			expect(res.status).toBe(400);
			expect(await countIssues()).toBe(0);
		});
	});

	describe("photo validation", () => {
		it("rejects a photo above the size limit", async () => {
			// 上限は 5MB。1 バイト超えたら弾かれること
			const res = await createIssueWithPhoto({
				bytes: imageBytes(5 * 1024 * 1024 + 1),
				type: "image/jpeg",
			});

			expect(res.status).toBe(400);
			const body = await readBody(res);
			expect(String(body.error)).toContain("5242880");

			// 弾いた以上、Issue も画像も残ってはいけない
			expect(await countIssues()).toBe(0);
			expect(await countPhotoObjects()).toBe(0);
		});

		it("accepts a photo at the size limit", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(5 * 1024 * 1024),
				type: "image/jpeg",
			});

			expect(res.status).toBe(201);
			expect(await countPhotoObjects()).toBe(1);
		});

		// SVG はスクリプトを埋め込める文書形式で、同一オリジンで配信すると
		// XSS の経路になる。保存させないこと
		it("rejects an SVG", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(64),
				type: "image/svg+xml",
				name: "photo.svg",
			});

			expect(res.status).toBe(400);
			expect(await countIssues()).toBe(0);
			expect(await countPhotoObjects()).toBe(0);
		});

		it("rejects a non-image content type", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(64),
				type: "text/html",
				name: "photo.html",
			});

			expect(res.status).toBe(400);
			expect(await countIssues()).toBe(0);
			expect(await countPhotoObjects()).toBe(0);
		});

		it.each([
			"image/jpeg",
			"image/png",
			"image/webp",
		])("accepts %s", async (type) => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(64),
				type,
			});

			expect(res.status).toBe(201);
			const stored = await readStoredIssue((await readBody(res)).id);
			expect(stored.photo_content_type).toBe(type);
		});

		// `image/jpeg; charset=binary` のようにパラメータが付いた形も、
		// 大小が揃っていない形も受け付けたうえで正規化すること
		it("normalizes a content type with parameters and casing", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(64),
				type: "IMAGE/JPEG; charset=binary",
			});

			expect(res.status).toBe(201);
			const stored = await readStoredIssue((await readBody(res)).id);
			expect(stored.photo_content_type).toBe("image/jpeg");
		});
	});

	describe("GET /issues/:id/photo", () => {
		/** 写真付きの Issue を 1 件作り、その id を返す。 */
		async function seedIssueWithPhoto(
			bytes = imageBytes(256),
			type = "image/jpeg",
		): Promise<string> {
			const res = await createIssueWithPhoto({ bytes, type });
			expect(res.status).toBe(201);
			return (await readBody(res)).id;
		}

		it("returns the stored bytes with the stored content type", async () => {
			const bytes = imageBytes(256);
			const id = await seedIssueWithPhoto(bytes, "image/png");

			const res = await app.request(`/issues/${id}/photo`, {}, env);

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("image/png");
			const received = new Uint8Array(await res.arrayBuffer());
			expect(received).toEqual(bytes);
		});

		// Issue 本体が公開なので、写真も認証なしで読める
		it("is public", async () => {
			const id = await seedIssueWithPhoto();

			setMockUserId(null);
			const res = await app.request(`/issues/${id}/photo`, {}, env);

			expect(res.status).toBe(200);
			// ボディは必ず読み切る。R2 のオブジェクトをストリームで返しているため、
			// 読まずに終わるとテスト間のストレージ分離（isolated storage）が
			// 後始末に失敗し、無関係なテストが 500 で落ちる
			await res.arrayBuffer();
		});

		it("returns 404 when the issue has no photo", async () => {
			const res = await createIssueAsJson();
			const { id } = await readBody(res);

			const photoRes = await app.request(`/issues/${id}/photo`, {}, env);

			expect(photoRes.status).toBe(404);
		});

		it("returns 404 for an unknown issue", async () => {
			const res = await app.request("/issues/does-not-exist/photo", {}, env);

			expect(res.status).toBe(404);
		});

		// 行はあるのに R2 の実体が消えている状態。500 ではなく 404 で、
		// かつ本文が JSON のエラーであること（他の 404 と形を揃える）
		it("returns 404 when the object is missing from R2", async () => {
			const id = await seedIssueWithPhoto();
			await env.PHOTOS.delete(photoObjectKey(id));

			const res = await app.request(`/issues/${id}/photo`, {}, env);

			expect(res.status).toBe(404);
			const body = await readBody(res);
			expect(body.error).toBe("Photo not found");
		});

		it("sets a cacheable, inline content disposition", async () => {
			const id = await seedIssueWithPhoto();

			const res = await app.request(`/issues/${id}/photo`, {}, env);

			expect(res.headers.get("Content-Disposition")).toBe("inline");
			expect(res.headers.get("Cache-Control")).toContain("max-age=");
			expect(res.headers.get("ETag")).toBeTruthy();
			// ヘッダしか見ないときもボディは読み切る（理由は "is public"）
			await res.arrayBuffer();
		});
	});

	/*
	 * 一覧用のサムネイル（Issue #125）。
	 *
	 * 一覧に写真が出ておらず、サイトが文字だけに見えるという感想が
	 * 本番の利用者から届いた。一覧は 20 件並ぶので、詳細ページ用の原寸を
	 * そのまま並べるわけにはいかない。投稿時にブラウザが作った派生物を
	 * 別のキーに置き、専用の経路から配る。
	 *
	 * ここで確かめたいのは 3 つ:
	 *  - 送られた派生物が原寸とは別に保存され、そちらが返ること
	 *  - 派生物を持たない写真（#125 より前の投稿）でも画像が返ること
	 *  - 派生物も原寸と同じ検査を通ること（配信経路が同じなので）
	 */
	describe("photo thumbnails", () => {
		it("stores the thumbnail under its own key, apart from the original", async () => {
			const photoBytes = imageBytes(2048);
			const thumbnailBytes = imageBytes(256);
			const res = await createIssueWithPhoto(
				{ bytes: photoBytes, type: "image/jpeg" },
				{},
				{ bytes: thumbnailBytes, type: "image/jpeg" },
			);
			expect(res.status).toBe(201);
			const { id } = await readBody(res);

			// 原寸は原寸のキーのまま。サムネイルに上書きされていない
			const original = await env.PHOTOS.get(photoObjectKey(id));
			expect(
				new Uint8Array(await (original as R2ObjectBody).arrayBuffer()),
			).toEqual(photoBytes);

			const stored = await env.PHOTOS.get(photoThumbnailObjectKey(id));
			expect(stored, "サムネイルが R2 に置かれていない").not.toBeNull();
			expect(
				new Uint8Array(await (stored as R2ObjectBody).arrayBuffer()),
			).toEqual(thumbnailBytes);
		});

		it("serves the thumbnail bytes, not the original", async () => {
			const photoBytes = imageBytes(2048);
			const thumbnailBytes = imageBytes(256);
			const created = await createIssueWithPhoto(
				{ bytes: photoBytes, type: "image/jpeg" },
				{},
				{ bytes: thumbnailBytes, type: "image/jpeg" },
			);
			const { id } = await readBody(created);

			const res = await app.request(`/issues/${id}/photo/thumbnail`, {}, env);

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("image/jpeg");
			const received = new Uint8Array(await res.arrayBuffer());
			// 一覧が原寸を読んでいないこと。ここが原寸に戻ると #125 の
			// 受け入れ条件（元画像をそのまま並べない）が黙って壊れる
			expect(received.byteLength).toBe(thumbnailBytes.byteLength);
			expect(received).toEqual(thumbnailBytes);
		});

		it("keeps serving the original when no thumbnail was uploaded", async () => {
			// #125 より前に投稿された写真。派生物が無いからといって 404 に
			// すると、古い Issue だけ一覧から画像が消える
			const photoBytes = imageBytes(512);
			const created = await createIssueWithPhoto({
				bytes: photoBytes,
				type: "image/png",
			});
			const { id } = await readBody(created);

			const res = await app.request(`/issues/${id}/photo/thumbnail`, {}, env);

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("image/png");
			expect(new Uint8Array(await res.arrayBuffer())).toEqual(photoBytes);
		});

		it("returns 404 when the issue has no photo at all", async () => {
			const res = await createIssueAsJson();
			const { id } = await readBody(res);

			const thumbRes = await app.request(
				`/issues/${id}/photo/thumbnail`,
				{},
				env,
			);

			expect(thumbRes.status).toBe(404);
		});

		it("returns 404 for an unknown issue", async () => {
			const res = await app.request(
				"/issues/does-not-exist/photo/thumbnail",
				{},
				env,
			);

			expect(res.status).toBe(404);
		});

		it("is public and cacheable like the original", async () => {
			const created = await createIssueWithPhoto(
				{ bytes: imageBytes(1024), type: "image/jpeg" },
				{},
				{ bytes: imageBytes(128), type: "image/jpeg" },
			);
			const { id } = await readBody(created);

			setMockUserId(null);
			const res = await app.request(`/issues/${id}/photo/thumbnail`, {}, env);

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Disposition")).toBe("inline");
			expect(res.headers.get("Cache-Control")).toContain("max-age=");
			expect(res.headers.get("ETag")).toBeTruthy();
			// ヘッダしか見ないときもボディは読み切る（理由は "is public"）
			await res.arrayBuffer();
		});

		// 配信されるのは原寸と同じ経路（同一オリジンで Content-Type を名乗る）
		// なので、SVG を通す穴になってはいけない
		it("rejects a thumbnail with a disallowed content type", async () => {
			const res = await createIssueWithPhoto(
				{ bytes: imageBytes(1024), type: "image/jpeg" },
				{},
				{ bytes: imageBytes(128), type: "image/svg+xml", name: "t.svg" },
			);

			expect(res.status).toBe(400);
			// 弾いたなら Issue そのものも作らない。作ってしまうと
			// 「エラーになったのに投稿されている」状態になる
			expect(await countIssues()).toBe(0);
			expect(await countPhotoObjects()).toBe(0);
		});

		/*
		 * サムネイルの上限は原寸（5MB）より小さい（#125、レビューで指摘）。
		 *
		 * 一覧を軽くするための派生物なのに 5MB を通すと、上限としての意味を
		 * ほとんど失う。自前のクライアント以外が大きな画像を `thumbnail` として
		 * 送ると、一覧が原寸より重くなりうる。
		 *
		 * 期待値は共有スキーマから引く。ここに数値を直書きすると、上限を
		 * 変えたときにテストだけが古い値を守り続ける
		 */
		it("rejects a thumbnail above the thumbnail size limit", async () => {
			const res = await createIssueWithPhoto(
				{ bytes: imageBytes(1024), type: "image/jpeg" },
				{},
				{
					bytes: imageBytes(ISSUE_THUMBNAIL_MAX_BYTES + 1),
					type: "image/jpeg",
				},
			);

			expect(res.status).toBe(400);
			expect(await countIssues()).toBe(0);
		});

		it("accepts a thumbnail at the thumbnail size limit", async () => {
			const res = await createIssueWithPhoto(
				{ bytes: imageBytes(1024), type: "image/jpeg" },
				{},
				{
					bytes: imageBytes(ISSUE_THUMBNAIL_MAX_BYTES),
					type: "image/jpeg",
				},
			);

			expect(res.status).toBe(201);
		});

		// 原寸の上限（5MB）をそのまま当てていないこと。両方に同じ値を
		// 使うと、上のテストは「5MB + 1」でしか落ちなくなる
		it("does not apply the full-size limit to the thumbnail", () => {
			expect(ISSUE_THUMBNAIL_MAX_BYTES).toBeLessThan(5 * 1024 * 1024);
		});

		/*
		 * 原寸に倒したときのキャッシュ指示（レビューで指摘）。
		 *
		 * この URL は、後から派生物が用意されれば中身が「原寸 →
		 * サムネイル」に変わる。`immutable` を付けたまま配ると、一度でも
		 * 一覧を開いた人のブラウザや中間キャッシュが最大 1 年間 原寸を
		 * 返し続け、差し替えが届かなくなる
		 */
		it("does not mark the original fallback as immutable", async () => {
			const created = await createIssueWithPhoto({
				bytes: imageBytes(512),
				type: "image/jpeg",
			});
			const { id } = await readBody(created);

			const res = await app.request(`/issues/${id}/photo/thumbnail`, {}, env);

			expect(res.headers.get("Cache-Control")).not.toContain("immutable");
			await res.arrayBuffer();
		});

		// 派生物が実在するときは中身が変わらないので、原寸と同じく長く持たせる
		it("marks a real thumbnail as immutable", async () => {
			const created = await createIssueWithPhoto(
				{ bytes: imageBytes(1024), type: "image/jpeg" },
				{},
				{ bytes: imageBytes(128), type: "image/jpeg" },
			);
			const { id } = await readBody(created);

			const res = await app.request(`/issues/${id}/photo/thumbnail`, {}, env);

			expect(res.headers.get("Cache-Control")).toContain("immutable");
			await res.arrayBuffer();
		});

		// 写真を付けずにサムネイルだけ送るのは、自前のクライアントが
		// しない組み合わせ。置く先が無いので黙って捨て、起票は通す
		it("ignores a thumbnail sent without a photo", async () => {
			const res = await createIssueWithPhoto(
				null,
				{},
				{
					bytes: imageBytes(128),
					type: "image/jpeg",
				},
			);

			expect(res.status).toBe(201);
			expect(await countPhotoObjects()).toBe(0);
		});

		it("removes the thumbnail from R2 along with the issue", async () => {
			const created = await createIssueWithPhoto(
				{ bytes: imageBytes(1024), type: "image/jpeg" },
				{},
				{ bytes: imageBytes(128), type: "image/jpeg" },
			);
			const { id } = await readBody(created);
			expect(await countPhotoObjects()).toBe(2);

			const res = await app.request(
				`/issues/${id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);

			expect(res.status).toBe(200);
			// 原寸だけ消してサムネイルが残ると、参照の切れた孤児ファイルになる
			expect(await countPhotoObjects()).toBe(0);
		});
	});

	describe("DELETE /issues/:id", () => {
		it("removes the photo from R2 along with the issue", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(128),
				type: "image/jpeg",
			});
			const { id } = await readBody(res);
			expect(await countPhotoObjects()).toBe(1);

			const deleteRes = await app.request(
				`/issues/${id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);

			expect(deleteRes.status).toBe(200);
			expect(await countIssues()).toBe(0);
			// 参照の切れた画像を残さない
			expect(await countPhotoObjects()).toBe(0);
		});

		// 他人の Issue の削除は 403。そのときに画像を消してはいけない
		// （「403 を返すが削除は実行する」形の退行を検出する）
		it("keeps the photo when the delete is denied", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(128),
				type: "image/jpeg",
			});
			const { id } = await readBody(res);

			setMockUserId("someone-else");
			const deleteRes = await app.request(
				`/issues/${id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);

			expect(deleteRes.status).toBe(403);
			expect(await countIssues()).toBe(1);
			expect(await countPhotoObjects()).toBe(1);
			// 画像が実際に読めるままであること
			setMockUserId(null);
			const photoRes = await app.request(`/issues/${id}/photo`, {}, env);
			expect(photoRes.status).toBe(200);
			// ボディは読み切る（理由は "is public"）
			await photoRes.arrayBuffer();
		});
	});

	describe("has_photo in list and detail responses", () => {
		it("reports the photo state without exposing the object key", async () => {
			await createIssueWithPhoto({ bytes: imageBytes(64), type: "image/jpeg" });
			await createIssueAsJson();

			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);

			expect(body.data).toHaveLength(2);
			// 1 件は写真あり、1 件は無し
			expect(
				body.data.map((issue: IssueBody) => issue.has_photo).sort(),
			).toEqual([false, true]);
			// R2 のキーはどこにも出てはいけない
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain("photo_key");
			expect(serialized).not.toContain("issues/");
		});

		it("reports has_photo in the detail response", async () => {
			const res = await createIssueWithPhoto({
				bytes: imageBytes(64),
				type: "image/jpeg",
			});
			const { id } = await readBody(res);

			const detail = await readBody(
				await app.request(`/issues/${id}`, {}, env),
			);

			expect(detail.has_photo).toBe(true);
			expect(detail).not.toHaveProperty("photo_key");
		});
	});
});
