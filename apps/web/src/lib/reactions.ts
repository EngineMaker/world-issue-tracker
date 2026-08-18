import { resolveApiBaseUrl } from "./issues";

/**
 * `GET /issues/:id/reactions` のレスポンス（#112）。
 *
 * `help-offers.ts` の `HelpOfferSummary` と違い、反応した人の一覧を持たない。
 * API 側が件数と真偽値しか返さないため（誰が押したかは公開しない決めごと。
 * 理由は `apps/api/src/routes/reactions.ts`）。
 */
export type ReactionSummary = {
	total: number;
	/** 閲覧者自身が反応済みか。未ログインなら常に false。 */
	viewerReacted: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** `GET /issues/:id/reactions` のレスポンスを検証する。合わなければ null。 */
export function parseReactionsResponse(value: unknown): ReactionSummary | null {
	if (!isRecord(value)) return null;
	if (typeof value.total !== "number") return null;
	// `viewer_reacted` が欠けたレスポンスを `false` として黙って通すと、
	// 反応済みの人にも「私も困っている」ボタンを出し続けることになる。
	// 形が違えば取得ごと失敗にする（`help-offers.ts` と同じ方針）
	if (typeof value.viewer_reacted !== "boolean") return null;

	return { total: value.total, viewerReacted: value.viewer_reacted };
}

/**
 * 反応の取得結果。
 *
 * `FetchHelpOffersResult` と同じく、失敗を throw ではなく値で返す。
 * 反応が取れなくても Issue 本体は表示できるため、ページ全体を落とさない。
 */
export type FetchReactionsResult =
	| { ok: true; summary: ReactionSummary }
	| { ok: false; error: string };

type FetchReactionsOptions = {
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: typeof globalThis.fetch;
	/**
	 * Clerk のセッショントークン。
	 *
	 * 渡すと `viewer_reacted` が埋まる（誰として見ているかが API に伝わる）。
	 * 省略すると未認証として扱われ、常に false になる。
	 */
	token?: string | null;
};

/** 反応の件数を取得する。 */
export async function fetchReactions(
	issueId: string,
	{ fetchImpl = globalThis.fetch, token = null }: FetchReactionsOptions = {},
): Promise<FetchReactionsResult> {
	const url = `${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}/reactions`;

	try {
		const res = await fetchImpl(url, {
			// 押した直後の再取得で古い件数を見せないため、キャッシュしない
			cache: "no-store",
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});

		if (!res.ok) {
			return { ok: false, error: `API が ${res.status} を返しました` };
		}

		const parsed = parseReactionsResponse(await res.json());
		if (!parsed) {
			return { ok: false, error: "API のレスポンス形式が想定と異なります" };
		}

		return { ok: true, summary: parsed };
	} catch (err) {
		console.error("GET /issues/:id/reactions に失敗", err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/** 反応の送信・取り消しに失敗したときに投げるエラー。 */
export class ReactionError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "ReactionError";
		this.status = status;
	}
}

/**
 * ステータスから利用者に見せるメッセージを組み立てる
 * （`help-offers.ts` の同名の関数と同じ方針。この API も入力を取らないので
 * ステータスだけで分岐する）。
 */
function messageFromStatus(status: number, action: string): string {
	if (status === 401) {
		return "ログインが必要です。ログインし直してからお試しください。";
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
 * 反応の送信・取り消しに共通する通信部分。
 *
 * どちらも本文を持たず、成否の判定もメッセージの組み立て方も同じなので
 * 一本にまとめている。呼び分けるのはメソッドと、エラー文言に出す動作名だけ。
 *
 * Web と API は別オリジンなので Clerk のセッション Cookie は届かない。
 * `Authorization: Bearer` で明示的に渡す。
 */
async function sendReaction(
	issueId: string,
	token: string | null,
	method: "POST" | "DELETE",
	action: string,
): Promise<void> {
	if (!token) {
		throw new ReactionError(
			"ログインが必要です。ログインしてからお試しください。",
			401,
		);
	}

	let response: Response;
	try {
		response = await fetch(
			`${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}/reactions`,
			{
				method,
				headers: { Authorization: `Bearer ${token}` },
			},
		);
	} catch {
		throw new ReactionError(
			"API に接続できませんでした。ネットワーク接続を確認してください。",
			null,
		);
	}

	if (!response.ok) {
		throw new ReactionError(
			messageFromStatus(response.status, action),
			response.status,
		);
	}
}

/** 「私も困っている」と反応する。 */
export async function react(
	issueId: string,
	token: string | null,
): Promise<void> {
	await sendReaction(issueId, token, "POST", "反応");
}

/** 反応を取り消す。 */
export async function withdrawReaction(
	issueId: string,
	token: string | null,
): Promise<void> {
	await sendReaction(issueId, token, "DELETE", "取り消し");
}
