import type { UpdateIssue } from "@world-issue-tracker/shared";
import {
	type PublicIssue,
	parsePublicIssue,
	resolveApiBaseUrl,
} from "./issues";

/**
 * 本文の編集に関わる通信（Issue #143）。
 *
 * タイトル・説明・スコープ・カテゴリの部分更新（`PATCH /issues/:id`）を扱う。
 * ステータス変更（`updateIssueStatus`）と所有者判定（`fetchViewerRelation`）は
 * `lib/issue-status.ts` にあり、こちらは同じ `PATCH` を本文向けに叩く。
 *
 * ブラウザから呼ぶ。Web と API は別オリジンなので Clerk のセッション Cookie は
 * 届かず、`Authorization: Bearer` で明示的にトークンを渡す
 * （`lib/issue-status.ts` と同じ事情）。
 */

/**
 * この module が使う範囲だけを表した `fetch` の型。
 *
 * `typeof globalThis.fetch` にしない理由は `lib/issue-status.ts` の `FetchLike`
 * と同じ（api 側の `tsc` では Workers 版の型に差し替わり、`cache` が無い）。
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

/** 本文の更新に失敗したときに投げるエラー。 */
export class IssueEditError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "IssueEditError";
		this.status = status;
	}
}

/**
 * ステータスコードから利用者に見せるメッセージを組み立てる。
 *
 * `lib/issue-status.ts` の `messageFromStatus` と同じ方針。403 の文言だけ
 * こちらは「編集」に合わせる。編集ボタンは起票者にしか出さないので、ここに
 * 来る 403 は「他人の Issue を編集しようとした」で確定しており、起票者だけが
 * 直せるという仕様そのものを伝えられる。
 */
function messageFromStatus(status: number): string {
	if (status === 401) {
		return "ログインが必要です。ログインし直してからお試しください。";
	}
	if (status === 403) {
		return "内容を編集できるのは、この Issue を起票した人だけです。";
	}
	if (status === 404) {
		return "この Issue は見つかりませんでした。削除された可能性があります。";
	}
	return `内容の更新に失敗しました (HTTP ${status})`;
}

type UpdateIssueContentOptions = {
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * Issue の本文を更新する（`PATCH /issues/:id`）。
 *
 * 送るのは編集フォームが扱う項目（タイトル・説明・スコープ・カテゴリ）。
 * ステータスは含めない。`UpdateIssueSchema` は部分更新を受けるので、
 * 呼び出し側（`validateIssueEdit`）が組み立てた `UpdateIssue` をそのまま渡す。
 *
 * 権限は API 側の `WHERE id = ? AND user_id = ?` が強制する。
 * 画面が編集 UI を隠すのは表示の都合であって、保護ではない。
 */
export async function updateIssueContent(
	issueId: string,
	update: UpdateIssue,
	token: string | null,
	{ fetchImpl = defaultFetch }: UpdateIssueContentOptions = {},
): Promise<PublicIssue> {
	if (!token) {
		throw new IssueEditError(
			"ログインが必要です。ログインしてからお試しください。",
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
			body: JSON.stringify(update),
		});
	} catch {
		throw new IssueEditError(
			"API に接続できませんでした。ネットワーク接続を確認してください。",
			null,
		);
	}

	if (!res.ok) {
		throw new IssueEditError(messageFromStatus(res.status), res.status);
	}

	// 200 が返っても中身が想定と違えば成功として扱わない。
	// 画面がそのまま新しい内容を表示すると、実際には変わっていない値を
	// 「変わった」と見せることになる（`updateIssueStatus` と同じ方針）。
	const issue = parsePublicIssue(await res.json());
	if (!issue) {
		throw new IssueEditError(
			"API のレスポンス形式が想定と異なります。反映されたか一覧で確認してください。",
			null,
		);
	}

	return issue;
}
