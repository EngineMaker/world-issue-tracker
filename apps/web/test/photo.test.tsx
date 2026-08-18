/**
 * 写真の添付（#65）に関する web 側のテスト。
 *
 * 見ているのは 3 つ:
 *  - 縮小の寸法計算（`fitWithin`）— 純粋関数なので直接呼ぶ
 *  - API との受け渡し（`parsePublicIssue` / `issuePhotoUrl` / `createIssue`）
 *  - 詳細ページが写真を実際に描画すること
 *
 * `resizeImageFile` 本体は `createImageBitmap` と `<canvas>` に依存し、
 * bun のテスト環境には無い。寸法計算だけを純粋関数として切り出して
 * あるのはそのためで、残りはブラウザでしか確かめられない
 * （PR 本文の「既知の未解決事項」に記載）。
 */

import { describe, expect, it } from "bun:test";
import { ISSUE_PHOTO_MAX_BYTES } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import IssueDetailPage from "../src/app/issues/[id]/page";
import { createIssue } from "../src/lib/api";
import { issuePhotoUrl, parsePublicIssue } from "../src/lib/issues";
import { fitWithin, PHOTO_MAX_EDGE } from "../src/lib/photo";
import {
	defaultCommentsResponse,
	defaultHelpOffersResponse,
	defaultReactionsResponse,
} from "./helpers/detail-stub";

const sampleIssue = {
	id: "ebbcf9d7680ad57cedeeb513a90d461f",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "infrastructure",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-02 09:30:00.000",
	has_photo: true,
};

describe("fitWithin — 縮小後の寸法", () => {
	it("長辺を上限に合わせ、縦横比を保つ", () => {
		expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
	});

	it("縦長でも長辺（高さ）を基準にする", () => {
		expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
	});

	// 拡大はしない。引き伸ばしても情報は増えず、ファイルサイズだけが増える
	it("既に上限内なら寸法を変えない", () => {
		expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
	});

	it("ちょうど上限のときも変えない", () => {
		expect(fitWithin(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
	});

	// 極端に細長い画像で短辺が 0 に丸まると canvas の生成が失敗する
	it("短辺が 0 に丸まらない", () => {
		const result = fitWithin(10000, 3, 1600);
		expect(result.width).toBe(1600);
		expect(result.height).toBeGreaterThanOrEqual(1);
	});

	it("既定の上限は 1600px", () => {
		expect(PHOTO_MAX_EDGE).toBe(1600);
		expect(fitWithin(3200, 3200)).toEqual({ width: 1600, height: 1600 });
	});
});

describe("parsePublicIssue — has_photo", () => {
	it("写真ありを真として読む", () => {
		const parsed = parsePublicIssue(sampleIssue);
		expect(parsed?.has_photo).toBe(true);
	});

	it("写真なしを偽として読む", () => {
		const parsed = parsePublicIssue({ ...sampleIssue, has_photo: false });
		expect(parsed?.has_photo).toBe(false);
	});

	// Web と API は別 Worker でデプロイのタイミングがずれる。API が古くて
	// `has_photo` を返さないときに一覧ごと失敗させると、写真という付加的な
	// 機能のために画面全体が失われる
	it("項目が無い古い API のレスポンスでも失敗しない", () => {
		const { has_photo: _omitted, ...withoutPhoto } = sampleIssue;
		const parsed = parsePublicIssue(withoutPhoto);
		expect(parsed).not.toBeNull();
		expect(parsed?.has_photo).toBe(false);
	});

	// 「無い」と「想定と違う形で来た」は別。後者を握り潰すと
	// API 側の変更が画面に静かに影響する
	it("真偽値でない値は弾く", () => {
		expect(parsePublicIssue({ ...sampleIssue, has_photo: "yes" })).toBeNull();
		expect(parsePublicIssue({ ...sampleIssue, has_photo: 1 })).toBeNull();
	});
});

describe("issuePhotoUrl", () => {
	it("API の配信エンドポイントを指す", () => {
		const original = process.env.NEXT_PUBLIC_API_URL;
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		try {
			expect(issuePhotoUrl("abc123")).toBe(
				"https://api.example.com/issues/abc123/photo",
			);
		} finally {
			if (original === undefined) {
				delete process.env.NEXT_PUBLIC_API_URL;
			} else {
				process.env.NEXT_PUBLIC_API_URL = original;
			}
		}
	});

	// R2 のキーは公開されないので、画像は必ずこの経路を通る。
	// 直接 R2 を指す URL に退行していないこと
	it("R2 のオブジェクトキーを含まない", () => {
		expect(issuePhotoUrl("abc123")).not.toContain("r2");
		expect(issuePhotoUrl("abc123")).toContain("/issues/abc123/photo");
	});
});

describe("createIssue — 写真の送信", () => {
	const validInput = {
		title: "駅前の街灯が切れている",
		description: "夜道が暗くて危ない",
		scope: "community" as const,
		latitude: 35.68,
		longitude: 139.76,
	};

	/** `fetch` を差し替えて、実際に組み立てられたリクエストを捕まえる。 */
	async function captureRequest(
		photo: File | null,
		thumbnail: File | null = null,
	): Promise<{ init: RequestInit }> {
		const original = globalThis.fetch;
		let captured: RequestInit | undefined;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			captured = init;
			return new Response(JSON.stringify({ id: "created-id" }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			await createIssue(validInput, "test-token", photo, thumbnail);
		} finally {
			globalThis.fetch = original;
		}

		if (!captured) {
			throw new Error("fetch was not called");
		}
		return { init: captured };
	}

	// 写真の無い投稿まで multipart に寄せると、送るバイト数が増えるうえ
	// API 側で数値項目を文字列から復元する経路を通ることになる
	it("写真が無ければ JSON で送る", async () => {
		const { init } = await captureRequest(null);

		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(typeof init.body).toBe("string");
		expect(JSON.parse(init.body as string).title).toBe(validInput.title);
	});

	it("写真があれば multipart で送り、全フィールドを載せる", async () => {
		const photo = new File([new Uint8Array(16)], "photo.jpg", {
			type: "image/jpeg",
		});
		const { init } = await captureRequest(photo);

		expect(init.body).toBeInstanceOf(FormData);
		const form = init.body as FormData;
		expect(form.get("title")).toBe(validInput.title);
		expect(form.get("description")).toBe(validInput.description);
		expect(form.get("scope")).toBe(validInput.scope);
		expect(form.get("latitude")).toBe(String(validInput.latitude));
		expect(form.get("longitude")).toBe(String(validInput.longitude));
		expect(form.get("photo")).toBeInstanceOf(File);
	});

	/*
	 * 一覧用のサムネイル（#125）。
	 *
	 * ここを見ないと、フォームが作った派生物が送られなくなっても
	 * 誰も気付けない。API 側のテストは `thumbnail` パートを自分で
	 * 組み立てて投げるので、web からの送信経路は素通りする
	 * （レビューで指摘された穴）。
	 */
	it("サムネイルがあれば multipart に載せる", async () => {
		const photo = new File([new Uint8Array(64)], "photo.jpg", {
			type: "image/jpeg",
		});
		const thumbnail = new File([new Uint8Array(16)], "thumbnail.jpg", {
			type: "image/jpeg",
		});
		const { init } = await captureRequest(photo, thumbnail);

		const form = init.body as FormData;
		const sent = form.get("thumbnail");
		expect(sent, "thumbnail パートが載っていない").toBeInstanceOf(File);
		// 原寸と取り違えていないこと。同じファイルを両方に入れても
		// 「載っている」だけの検査は通ってしまう
		expect((sent as File).size).toBe(thumbnail.size);
		expect((form.get("photo") as File).size).toBe(photo.size);
	});

	// 作れなかったとき（`createThumbnailFile` が null を返したとき）は
	// 空のパートを送らない。API 側は空のファイルパートを「写真なし」として
	// 扱うが、そこに頼らず送る側で落とす
	it("サムネイルが無ければ thumbnail パートを送らない", async () => {
		const photo = new File([new Uint8Array(16)], "photo.jpg", {
			type: "image/jpeg",
		});
		const { init } = await captureRequest(photo, null);

		expect((init.body as FormData).has("thumbnail")).toBe(false);
	});

	// 手で `multipart/form-data` と書くと境界文字列（boundary）が欠け、
	// サーバー側で解析できなくなる。fetch に付けさせること
	it("multipart のときは Content-Type を自分で指定しない", async () => {
		const photo = new File([new Uint8Array(16)], "photo.jpg", {
			type: "image/jpeg",
		});
		const { init } = await captureRequest(photo);

		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBeUndefined();
		// 認証は multipart でも必要
		expect(headers.Authorization).toBe("Bearer test-token");
	});

	// 未入力の任意項目を空文字で送ると API 側の `min(1)` に当たる
	it("カテゴリが未指定なら送らない", async () => {
		const photo = new File([new Uint8Array(16)], "photo.jpg", {
			type: "image/jpeg",
		});
		const { init } = await captureRequest(photo);

		expect((init.body as FormData).has("category")).toBe(false);
	});
});

describe("Issue 詳細ページ — 写真の表示", () => {
	/**
	 * ページを描画する。API の応答は `fetch` を差し替えて与える。
	 *
	 * comments / reactions / help-offers は実 API 契約に沿った既定応答を
	 * 共有ヘルパーから返す。ここを契約からずらすと web 側パーサに弾かれ、
	 * ボタンが「取得に失敗しました」のまま描画される（#139）。
	 */
	async function renderDetail(issue: Record<string, unknown>): Promise<string> {
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string) => {
			if (String(url).endsWith("/comments")) {
				return defaultCommentsResponse();
			}
			if (String(url).endsWith("/reactions")) {
				return defaultReactionsResponse();
			}
			if (String(url).endsWith("/help-offers")) {
				return defaultHelpOffersResponse();
			}
			return new Response(JSON.stringify(issue), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const element = await IssueDetailPage({
				params: Promise.resolve({ id: String(issue.id) }),
			});
			return renderToStaticMarkup(element);
		} finally {
			globalThis.fetch = original;
		}
	}

	it("写真がある Issue では画像を出す", async () => {
		const html = await renderDetail(sampleIssue);

		expect(html).toContain(issuePhotoUrl(sampleIssue.id));
		expect(html).toContain("<h2>写真</h2>");
	});

	// 画像には代替テキストが要る。読み上げ環境や、読み込みに失敗したときに
	// 何の画像だったかが伝わらない
	it("画像に代替テキストを付ける", async () => {
		const html = await renderDetail(sampleIssue);

		expect(html).toContain(`alt="${sampleIssue.title} の様子"`);
	});

	// 写真が無いときは何も出さない。場所は地図（#63）が代役を務める
	it("写真が無い Issue では画像を出さない", async () => {
		const html = await renderDetail({ ...sampleIssue, has_photo: false });

		expect(html).not.toContain(issuePhotoUrl(sampleIssue.id));
		expect(html).not.toContain("<h2>写真</h2>");
	});

	// スタブが実 API 契約を再現できていること（#139）。
	//
	// help-offers / reactions のスタブが契約からずれると、web 側パーサに
	// 弾かれてボタンが「取得に失敗しました」のまま描画される。写真の assert
	// だけでは緑のままなので、両ボタンが取得成功の状態で描かれていることを
	// ここで守る。ずれれば取得失敗の文言が出て落ちる。
	it("表明・反応の取得に失敗した状態で描画していない", async () => {
		const html = await renderDetail(sampleIssue);

		expect(html).not.toContain("手伝いの表明を取得できませんでした");
		expect(html).not.toContain("反応を取得できませんでした");
		// 取得成功時に出る見出し。失敗時は出ない
		expect(html).toContain("解決に動く人");
	});
});

describe("上限の値", () => {
	// 画面側の文言とサーバー側の検査が同じ定数を見ていること
	it("共有スキーマの 5MB を使う", () => {
		expect(ISSUE_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
	});
});
