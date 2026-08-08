import type { IssueStatus as IssueStatusType } from "@world-issue-tracker/shared";
import {
	type PublicIssue,
	parsePublicIssue,
	resolveApiBaseUrl,
} from "./issues";

/**
 * ステータス変更に関わる通信（Issue #62）。
 *
 * 「閲覧者が起票者か」の判定（`GET /issues/:id/viewer`）と、
 * ステータスの更新（`PATCH /issues/:id`）を扱う。
 *
 * どちらもブラウザから呼ぶ。Web と API は別オリジンなので Clerk の
 * セッション Cookie は届かず、`Authorization: Bearer` で明示的に渡す
 * （`lib/help-offers.ts` と同じ事情）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 閲覧者とこの Issue の関係。今のところ「起票者か」だけ。 */
export type ViewerRelation = {
	/** 閲覧者がこの Issue の起票者か。未ログインなら常に false。 */
	viewerIsOwner: boolean;
};

/**
 * `GET /issues/:id/viewer` のレスポンスを検証する。合わなければ null。
 *
 * 欠けた値を false として黙って通してはいけない。起票者にも操作 UI が
 * 出なくなり、この Issue が直そうとしている症状（どこからも変えられない）が
 * そのまま残る。形が違えば取得ごと失敗させて、画面側で
 * 「判定できなかった」として扱えるようにする。
 */
export function parseViewerRelation(value: unknown): ViewerRelation | null {
	if (!isRecord(value)) return null;
	if (typeof value.viewer_is_owner !== "boolean") return null;
	return { viewerIsOwner: value.viewer_is_owner };
}

/**
 * この module が使う範囲だけを表した `fetch` の型。
 *
 * `typeof globalThis.fetch` にしない理由は `lib/issues.ts` の `FetchLike` と同じ
 * （api 側の `tsc` では Workers 版の型に差し替わり、`cache` が無い）。
 * こちらは `method` / `body` も使うため、その分だけ広げてある。
 */
type FetchLike = (
	url: string,
	init: {
		cache: "no-store";
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

/**
 * 実行環境の `fetch`。差し替えない場合の既定値。
 *
 * module のロード時に束縛せず呼ぶ瞬間に読む理由は `lib/issues.ts` と同じ
 * （テストが `globalThis.fetch` を差し替えるため）。
 */
const defaultFetch: FetchLike = (url, init) =>
	(globalThis.fetch as unknown as FetchLike)(url, init);

/** Issue 1 件の URL。ID はパスに入るので必ずエンコードする（`fetchIssue` と同じ）。 */
function issueUrl(issueId: string): string {
	return `${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}`;
}

/**
 * 起票者判定の取得結果。
 *
 * 失敗を throw ではなく値で返す（`FetchIssuesResult` と同じ方針）。
 * 判定できなくても Issue 本体は表示できるため、ページ全体を落とさない。
 */
export type FetchViewerRelationResult =
	| { ok: true; viewerIsOwner: boolean }
	| { ok: false; error: string };

type FetchViewerRelationOptions = {
	/** Clerk のセッショントークン。未サインインなら null。 */
	token: string | null;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * 閲覧者がこの Issue の起票者かを問い合わせる。
 *
 * 未ログインなら答えは false で確定しているので、往復せずその場で返す
 * （`fetchMyIssues` がトークン無しで API を呼ばないのと同じ）。
 */
export async function fetchViewerRelation(
	issueId: string,
	{ token, fetchImpl = defaultFetch }: FetchViewerRelationOptions,
): Promise<FetchViewerRelationResult> {
	if (!token) {
		return { ok: true, viewerIsOwner: false };
	}

	const url = `${issueUrl(issueId)}/viewer`;

	try {
		// 直前に他のタブで所有者が変わることは無いが、判定を古い値で
		// 固定されると操作 UI の出し分けが実態とずれるため、キャッシュしない
		const res = await fetchImpl(url, {
			cache: "no-store",
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!res.ok) {
			return { ok: false, error: `API が ${res.status} を返しました` };
		}

		const parsed = parseViewerRelation(await res.json());
		if (!parsed) {
			return { ok: false, error: "API のレスポンス形式が想定と異なります" };
		}

		return { ok: true, viewerIsOwner: parsed.viewerIsOwner };
	} catch (err) {
		console.error("GET /issues/:id/viewer に失敗", err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/** ステータスの更新に失敗したときに投げるエラー。 */
export class IssueStatusError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "IssueStatusError";
		this.status = status;
	}
}

/**
 * ステータスから利用者に見せるメッセージを組み立てる。
 *
 * `lib/help-offers.ts` の `messageFromStatus` と同じ方針だが、403 の文言は
 * こちらの方が具体的にできる。「手伝います」の 403 は本来起きない経路だが、
 * ステータス変更の 403 は「他人の Issue を変えようとした」で確定していて、
 * 起票者だけが変えられるという仕様そのものを伝えられる。
 */
function messageFromStatus(status: number): string {
	if (status === 401) {
		return "ログインが必要です。サインインし直してからお試しください。";
	}
	if (status === 403) {
		return "ステータスを変更できるのは、この Issue を起票した人だけです。";
	}
	if (status === 404) {
		return "この Issue は見つかりませんでした。削除された可能性があります。";
	}
	return `ステータスの更新に失敗しました (HTTP ${status})`;
}

type UpdateIssueStatusOptions = {
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * Issue のステータスを更新する（`PATCH /issues/:id`）。
 *
 * 送るのは `status` だけ。画面が持っているタイトルや説明を一緒に送ると、
 * 開いてから更新するまでの間に他の経路で本文が変わっていた場合、
 * 古い値で上書きしてしまう。`UpdateIssueSchema` は部分更新を受けるので、
 * 変えたい項目だけを送れば足りる。
 *
 * 遷移の順序（`open → triaged → ...`）は検証していない。API 側も
 * 飛び越しを許しており、順序の強制は別の判断を含むため
 * （Issue #62 のコメントで範囲外と整理されている）。
 *
 * 権限は API 側の `WHERE id = ? AND user_id = ?` が強制する。
 * 画面が操作 UI を隠すのは表示の都合であって、保護ではない。
 */
export async function updateIssueStatus(
	issueId: string,
	status: IssueStatusType,
	token: string | null,
	{ fetchImpl = defaultFetch }: UpdateIssueStatusOptions = {},
): Promise<PublicIssue> {
	if (!token) {
		throw new IssueStatusError(
			"ログインが必要です。サインインしてからお試しください。",
			401,
		);
	}

	let res: Awaited<ReturnType<FetchLike>>;
	try {
		res = await fetchImpl(issueUrl(issueId), {
			cache: "no-store",
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ status }),
		});
	} catch {
		throw new IssueStatusError(
			"API に接続できませんでした。ネットワーク接続を確認してください。",
			null,
		);
	}

	if (!res.ok) {
		throw new IssueStatusError(messageFromStatus(res.status), res.status);
	}

	// 200 が返っても中身が想定と違えば成功として扱わない。
	// 画面がそのまま新しいステータスを表示すると、実際には変わっていない値を
	// 「変わった」と見せることになる
	const issue = parsePublicIssue(await res.json());
	if (!issue) {
		throw new IssueStatusError(
			"API のレスポンス形式が想定と異なります。反映されたか一覧で確認してください。",
			null,
		);
	}

	return issue;
}
