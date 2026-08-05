import type {
	IssueScope as IssueScopeType,
	IssueSort as IssueSortType,
	IssueStatus as IssueStatusType,
} from "@world-issue-tracker/shared";
import {
	ISSUE_SEARCH_MAX_LENGTH,
	IssueScope,
	IssueSort,
	IssueStatus,
	LIST_ISSUES_DEFAULT_SORT,
} from "@world-issue-tracker/shared";

/**
 * 公開 GET が返す Issue 1 件の形。
 *
 * API 側の `PUBLIC_ISSUE_COLUMNS`（`apps/api/src/routes/issues.ts`）に対応する。
 * `user_id` のような内部フィールドは公開レスポンスに含まれないため、ここにも無い。
 */
export type PublicIssue = {
	/** `TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))` なので文字列。 */
	id: string;
	title: string;
	description: string;
	scope: IssueScopeType;
	status: IssueStatusType;
	latitude: number;
	longitude: number;
	category: string | null;
	created_at: string;
	updated_at: string;
};

const SCOPES: readonly string[] = IssueScope.options;
const STATUSES: readonly string[] = IssueStatus.options;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * `unknown` を `PublicIssue` として検証する。合わなければ null。
 *
 * API とはネットワーク越しなので、型注釈だけでは形を保証できない。
 * 想定外の値（デプロイのズレ、プロキシの差し込み）が描画まで届かないよう、
 * 受け取った直後にここで弾く。
 */
export function parsePublicIssue(value: unknown): PublicIssue | null {
	if (!isRecord(value)) return null;

	const {
		id,
		title,
		description,
		scope,
		status,
		latitude,
		longitude,
		category,
		created_at,
		updated_at,
	} = value;

	if (typeof id !== "string") return null;
	if (typeof title !== "string") return null;
	if (typeof description !== "string") return null;
	if (typeof scope !== "string" || !SCOPES.includes(scope)) return null;
	if (typeof status !== "string" || !STATUSES.includes(status)) return null;
	// `typeof` だけだと NaN / Infinity を通してしまう。地図に渡したときに
	// 壊れるので、有限な数値であることまで確かめる
	if (typeof latitude !== "number" || !Number.isFinite(latitude)) return null;
	if (typeof longitude !== "number" || !Number.isFinite(longitude)) return null;
	if (category !== null && typeof category !== "string") return null;
	if (typeof created_at !== "string") return null;
	if (typeof updated_at !== "string") return null;

	return {
		id,
		title,
		description,
		scope: scope as IssueScopeType,
		status: status as IssueStatusType,
		latitude,
		longitude,
		category,
		created_at,
		updated_at,
	};
}

/** `GET /issues` のレスポンスを検証する。合わなければ null。 */
export function parseListIssuesResponse(
	value: unknown,
): { issues: PublicIssue[]; total: number } | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.data)) return null;
	if (typeof value.total !== "number") return null;

	const issues: PublicIssue[] = [];
	for (const item of value.data) {
		const issue = parsePublicIssue(item);
		// 1 件でも形が違えば全体を失敗にする。一部だけ欠けた一覧を
		// 「これで全部です」という顔で見せない
		if (!issue) return null;
		issues.push(issue);
	}

	return { issues, total: value.total };
}

/**
 * `NEXT_PUBLIC_API_URL` 未設定時の既定値。
 *
 * ローカル開発の API（`bun dev` で起動する wrangler）を指す。本番 URL ではなく
 * ローカルを既定にしているのは、CI やデプロイで環境変数を渡し忘れたときに
 * 「本番 API に繋がって一見動く」よりも「繋がらず失敗が見える」方が設定漏れに
 * 気付けるため。
 *
 * 本番で値を渡す経路は `.github/workflows/deploy.yml` のビルド時の一本だけ。
 * `apps/web/wrangler.jsonc` の `vars` にも同じ値があるが、そちらは届かない
 * （理由は `resolveApiBaseUrl` のコメント）。
 */
const DEFAULT_API_BASE_URL = "http://localhost:8787";

/**
 * API のベース URL を解決する。末尾のスラッシュは取り除く。
 *
 * `process.env.NEXT_PUBLIC_API_URL` は Next.js が **ビルド時に静的置換する**。
 * Client Component だけでなく Server Component のバンドルでも置換され、
 * 生成物からは `process.env` の参照そのものが消える。したがって実行時に
 * Worker の `env` を渡しても読む側が居ない（`wrangler.jsonc` の `vars` が
 * Server Component に届かないのはこのため）。
 *
 * 置換の対象になるのは静的に書かれた参照だけなので、`process.env[key]` の
 * ような動的アクセスにしてはいけない（置換されず undefined になる）。
 *
 * 実行時に読む形へ変えたい場合は `@opennextjs/cloudflare` の
 * `getCloudflareContext().env` を使う。今は必要が無いのでビルド時の一本に絞っている。
 */
export function resolveApiBaseUrl(): string {
	const configured = process.env.NEXT_PUBLIC_API_URL;
	const base = configured?.trim() ? configured.trim() : DEFAULT_API_BASE_URL;
	return base.replace(/\/+$/, "");
}

/**
 * Issue 一覧の取得結果。
 *
 * 取得に失敗しても throw せず、失敗を値として返す。ページ側で
 * 「0 件」と「取得できなかった」を別の表示にし分けられるようにするため。
 */
export type FetchIssuesResult =
	| {
			ok: true;
			issues: PublicIssue[];
			/** 絞り込み条件を適用したうえでの総件数（表示中の件数ではない） */
			total: number;
			/** この取得で要求した 1 ページあたりの件数。ページング UI が使う */
			limit: number;
			/** この取得で要求した開始位置。ページング UI が使う */
			offset: number;
	  }
	| { ok: false; error: string };

/**
 * 一覧の絞り込み・並べ替え条件。
 *
 * URL の `searchParams` と 1 対 1 で対応させ、ページはこの値だけを見て
 * 描画する。Server Component のまま「今の条件」が URL に載るので、
 * 共有・ブックマーク・戻るボタンがそのまま効く（`app/page.tsx` のコメント参照）。
 */
export type IssueFilters = {
	scope?: IssueScopeType;
	status?: IssueStatusType;
	category?: string;
	/** キーワード。タイトル・説明の部分一致で API 側が引く */
	q?: string;
	sort: IssueSortType;
	/** 何件目から表示するか。ページング UI が limit 単位で動かす */
	offset: number;
};

/** フィルタ未指定時の既定値。ページングは先頭、並び順は新しい順 */
export const DEFAULT_ISSUE_FILTERS: IssueFilters = {
	sort: LIST_ISSUES_DEFAULT_SORT,
	offset: 0,
};

/** Next.js の `searchParams` が渡してくる値の形（同名キーが複数あると配列になる） */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * `searchParams` の 1 つを単一の文字列として読む。
 *
 * 同名キーが複数あると配列になるが、そのときは最初の値だけを使う。
 * URL は利用者が手で編集できる以上、想定外の形でページを落とすより、
 * 決め打ちで 1 つ選んで描画を続ける方が親切なため（API 側は重複を
 * 400 で弾くが、こちらは 1 つに正規化してから送る）。
 */
function readParam(params: RawSearchParams, key: string): string | undefined {
	const value = params[key];
	const single = Array.isArray(value) ? value[0] : value;
	if (typeof single !== "string") return undefined;
	const trimmed = single.trim();
	return trimmed.length ? trimmed : undefined;
}

/**
 * URL のクエリを `IssueFilters` に正規化する。
 *
 * 未知の値（`scope=galactic`、`offset=-1` など）は捨てて既定値に倒す。
 * 利用者が URL を直接いじったときや、古いブックマークを開いたときに
 * エラー画面を出さず、「絞り込み無しの一覧」として成立させるため。
 */
export function parseIssueFilters(params: RawSearchParams): IssueFilters {
	const scope = IssueScope.safeParse(readParam(params, "scope"));
	const status = IssueStatus.safeParse(readParam(params, "status"));
	const sort = IssueSort.safeParse(readParam(params, "sort"));

	const rawOffset = readParam(params, "offset");
	// 10 進の整数表記だけを受ける（API 側の `DecimalIntQueryParam` と同じ契約）。
	// 弾いた値は 0 に倒すので、`offset=abc` は先頭ページになる。
	const offset =
		rawOffset && /^\d+$/.test(rawOffset) ? Number(rawOffset) : undefined;

	const category = readParam(params, "category");
	const q = readParam(params, "q");

	return {
		scope: scope.success ? scope.data : undefined,
		status: status.success ? status.data : undefined,
		// API 側の上限（100 文字）を超える値は送っても 400 になるだけなので、
		// ここで落として「絞り込み無し」として扱う
		category: category && category.length <= 100 ? category : undefined,
		q: q && q.length <= ISSUE_SEARCH_MAX_LENGTH ? q : undefined,
		sort: sort.success ? sort.data : DEFAULT_ISSUE_FILTERS.sort,
		offset: offset ?? DEFAULT_ISSUE_FILTERS.offset,
	};
}

/**
 * フィルタを URL のクエリ文字列に戻す。
 *
 * 既定値（並び順が新しい順、先頭ページ）はクエリに載せない。
 * 何も絞っていないときの URL が `/issues` のままになり、
 * 「条件が付いているかどうか」が URL を見て分かる。
 */
export function buildIssueQueryString(filters: IssueFilters): string {
	const params = new URLSearchParams();
	if (filters.scope) params.set("scope", filters.scope);
	if (filters.status) params.set("status", filters.status);
	if (filters.category) params.set("category", filters.category);
	if (filters.q) params.set("q", filters.q);
	if (filters.sort !== DEFAULT_ISSUE_FILTERS.sort) {
		params.set("sort", filters.sort);
	}
	if (filters.offset > 0) params.set("offset", String(filters.offset));
	return params.toString();
}

/** 一覧ページの URL。条件が無ければクエリの付かない `/issues` になる */
export function buildIssuesHref(filters: IssueFilters): string {
	const query = buildIssueQueryString(filters);
	return query ? `/issues?${query}` : "/issues";
}

/** 絞り込み条件が 1 つでも付いているか。「条件をすべて解除」を出すかの判断に使う */
export function hasActiveFilters(filters: IssueFilters): boolean {
	return Boolean(
		filters.scope ||
			filters.status ||
			filters.category ||
			filters.q ||
			filters.sort !== DEFAULT_ISSUE_FILTERS.sort,
	);
}

type FetchIssuesOptions = {
	/** 取得件数。API 側の上限は 100。 */
	limit?: number;
	/** 絞り込み・並べ替え条件。省略時は既定値（絞り込み無し・新しい順・先頭ページ） */
	filters?: IssueFilters;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: typeof globalThis.fetch;
};

/**
 * API から Issue 一覧を取得する。
 *
 * Server Component から呼ぶことを前提にしている（サーバー間通信なので
 * ブラウザの CORS を経由しない）。
 */
export async function fetchIssues({
	limit = 20,
	filters = DEFAULT_ISSUE_FILTERS,
	fetchImpl = globalThis.fetch,
}: FetchIssuesOptions = {}): Promise<FetchIssuesResult> {
	// 値のエスケープは `URLSearchParams` に任せる。手で連結すると
	// カテゴリやキーワードに含まれる `&` `=` `#` がクエリを壊す
	const params = new URLSearchParams({ limit: String(limit) });
	if (filters.scope) params.set("scope", filters.scope);
	if (filters.status) params.set("status", filters.status);
	if (filters.category) params.set("category", filters.category);
	if (filters.q) params.set("q", filters.q);
	if (filters.sort !== DEFAULT_ISSUE_FILTERS.sort) {
		params.set("sort", filters.sort);
	}
	if (filters.offset > 0) params.set("offset", String(filters.offset));

	const url = `${resolveApiBaseUrl()}/issues?${params.toString()}`;

	try {
		// 投稿された Issue が次のアクセスで見えるよう、キャッシュしない
		const res = await fetchImpl(url, { cache: "no-store" });

		if (!res.ok) {
			return { ok: false, error: `API が ${res.status} を返しました` };
		}

		// 想定外の形（プロキシの HTML エラーページ等）でも throw させない
		const parsed = parseListIssuesResponse(await res.json());
		if (!parsed) {
			return { ok: false, error: "API のレスポンス形式が想定と異なります" };
		}

		// limit / offset はレスポンスの値ではなく要求した値を返す。
		// ページング UI は「次のページの offset」を自分で組み立てるため、
		// API が何を返したかより、いまどこを見ているかが要る
		return {
			ok: true,
			issues: parsed.issues,
			total: parsed.total,
			limit,
			offset: filters.offset,
		};
	} catch (err) {
		// API が落ちている / 名前解決できない / JSON として壊れている。
		// 生の例外メッセージ（`fetch failed` など）は画面に出さず、
		// 切り分けに要る情報はサーバーのログに残す
		console.error("GET /issues に失敗", err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}
