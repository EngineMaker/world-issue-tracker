import { resolveApiBaseUrl } from "./issues";

/**
 * 「手伝います」の表明 1 件。
 *
 * API 側の `PublicHelpOfferWithName`（`apps/api/src/routes/help-offers.ts`）に対応する。
 * `user_id` は Clerk の内部 ID で、表示名ではない。
 */
export type HelpOffer = {
	id: string;
	user_id: string;
	created_at: string;
	/**
	 * Clerk から引いた表示名（#108）。
	 *
	 * null は「Clerk に表示名が設定されていない」か「API が Clerk へ
	 * 問い合わせられなかった」のどちらか。画面はどちらも同じ文言で出す。
	 */
	display_name: string | null;
};

/** `GET /issues/:id/help-offers` のレスポンス。 */
export type HelpOfferSummary = {
	offers: HelpOffer[];
	total: number;
	/** 閲覧者自身が表明済みか。未ログインなら常に false。 */
	viewerOffered: boolean;
	/**
	 * 閲覧者の Clerk User ID。未ログインなら null。
	 *
	 * 一覧のどの行が自分の表明かを示すために使う。
	 * `viewerOffered` だけでは行と対応付けられない。
	 */
	viewerUserId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * `unknown` を `HelpOffer` として検証する。合わなければ null。
 *
 * `lib/issues.ts` の `parsePublicIssue` と同じ方針。API とはネットワーク越しなので、
 * 型注釈だけでは形を保証できない。
 */
export function parseHelpOffer(value: unknown): HelpOffer | null {
	if (!isRecord(value)) return null;

	const { id, user_id, created_at, display_name } = value;

	if (typeof id !== "string") return null;
	if (typeof user_id !== "string") return null;
	if (typeof created_at !== "string") return null;

	// `display_name` だけは、形が違っても表明そのものは捨てない（#108）。
	//
	// 他のフィールドと扱いを変えているのは、これが無くても一覧の意味が
	// 成立するため。ここで全体を失敗にすると、API 側の不調や版のずれで
	// 「解決に動く人」の一覧ごと消える。表示名は「あると嬉しい」情報であって、
	// それを厳しく検証して本体を巻き添えにするのは順序が逆になる。
	const displayName =
		typeof display_name === "string" && display_name !== ""
			? display_name
			: null;

	return { id, user_id, created_at, display_name: displayName };
}

/** `GET /issues/:id/help-offers` のレスポンスを検証する。合わなければ null。 */
export function parseHelpOffersResponse(
	value: unknown,
): HelpOfferSummary | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.data)) return null;
	if (typeof value.total !== "number") return null;
	// `viewer_offered` が欠けたレスポンスを `false` として黙って通すと、
	// 表明済みの人にも「手伝います」ボタンを出し続けることになる。
	// 形が違えば取得ごと失敗にする
	if (typeof value.viewer_offered !== "boolean") return null;
	// 未ログインなら null。文字列でも null でもない値は想定外
	if (value.viewer_user_id !== null && typeof value.viewer_user_id !== "string")
		return null;

	const offers: HelpOffer[] = [];
	for (const item of value.data) {
		const offer = parseHelpOffer(item);
		// 1 件でも形が違えば全体を失敗にする（`parseListIssuesResponse` と同じ）
		if (!offer) return null;
		offers.push(offer);
	}

	return {
		offers,
		total: value.total,
		viewerOffered: value.viewer_offered,
		viewerUserId: value.viewer_user_id,
	};
}

/**
 * 表明の取得結果。
 *
 * `FetchIssuesResult` と同じく、失敗を throw ではなく値で返す。
 * 表明が取れなくても Issue 本体は表示できるため、ページ全体を落とさない。
 */
export type FetchHelpOffersResult =
	| { ok: true; summary: HelpOfferSummary }
	| { ok: false; error: string };

type FetchHelpOffersOptions = {
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: typeof globalThis.fetch;
	/**
	 * Clerk のセッショントークン。
	 *
	 * 渡すと `viewer_offered` が埋まる（誰として見ているかが API に伝わる）。
	 * 省略すると未ログインとして扱われ、常に false になる。
	 */
	token?: string | null;
};

/** 表明の一覧を取得する。 */
export async function fetchHelpOffers(
	issueId: string,
	{ fetchImpl = globalThis.fetch, token = null }: FetchHelpOffersOptions = {},
): Promise<FetchHelpOffersResult> {
	const url = `${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}/help-offers`;

	try {
		const res = await fetchImpl(url, {
			// 押した直後の再取得で古い件数を見せないため、キャッシュしない
			cache: "no-store",
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});

		if (!res.ok) {
			return { ok: false, error: `API が ${res.status} を返しました` };
		}

		const parsed = parseHelpOffersResponse(await res.json());
		if (!parsed) {
			return { ok: false, error: "API のレスポンス形式が想定と異なります" };
		}

		return { ok: true, summary: parsed };
	} catch (err) {
		console.error("GET /issues/:id/help-offers に失敗", err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/** 表明の送信・取り消しに失敗したときに投げるエラー。 */
export class HelpOfferError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "HelpOfferError";
		this.status = status;
	}
}

/**
 * ステータスから利用者に見せるメッセージを組み立てる。
 *
 * `lib/api.ts` の `messageFromErrorBody` と違い、こちらの API は
 * 入力を取らない（本文の無い POST / DELETE）ため、バリデーションエラーの
 * 詳細を組み立てる必要が無い。ステータスだけで分岐する。
 */
function messageFromStatus(status: number, action: string): string {
	if (status === 401) {
		return "ログインが必要です。サインインし直してからお試しください。";
	}
	if (status === 403) {
		return "この操作は許可されていません。";
	}
	if (status === 404) {
		return "この Issue は見つかりませんでした。削除された可能性があります。";
	}
	return `${action}に失敗しました (HTTP ${status})`;
}

/**
 * 表明の送信・取り消しに共通する通信部分。
 *
 * どちらも本文を持たず、成否の判定もメッセージの組み立て方も同じなので
 * 一本にまとめている。呼び分けるのはメソッドと、エラー文言に出す動作名だけ。
 *
 * `lib/api.ts` の `createIssue` と同じく、Web と API は別オリジンなので
 * Clerk のセッション Cookie は届かない。`Authorization: Bearer` で明示的に渡す。
 */
async function sendHelpOffer(
	issueId: string,
	token: string | null,
	method: "POST" | "DELETE",
	action: string,
): Promise<void> {
	if (!token) {
		throw new HelpOfferError(
			"ログインが必要です。サインインしてからお試しください。",
			401,
		);
	}

	let response: Response;
	try {
		response = await fetch(
			`${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}/help-offers`,
			{
				method,
				headers: { Authorization: `Bearer ${token}` },
			},
		);
	} catch {
		throw new HelpOfferError(
			"API に接続できませんでした。ネットワーク接続を確認してください。",
			null,
		);
	}

	if (!response.ok) {
		throw new HelpOfferError(
			messageFromStatus(response.status, action),
			response.status,
		);
	}
}

/** 「手伝います」と表明する。 */
export async function offerHelp(
	issueId: string,
	token: string | null,
): Promise<void> {
	await sendHelpOffer(issueId, token, "POST", "表明");
}

/** 表明を取り消す。 */
export async function withdrawHelp(
	issueId: string,
	token: string | null,
): Promise<void> {
	await sendHelpOffer(issueId, token, "DELETE", "取り消し");
}
