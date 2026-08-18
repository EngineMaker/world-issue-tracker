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
import {
	type FetchCommentsResult,
	parseListCommentsResponse,
} from "./comments";

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
	/**
	 * 写真が添付されているか（#65）。
	 *
	 * 画像そのものの URL ではなく有無だけが返る。R2 のオブジェクトキーは
	 * 内部の識別子で公開されないため、画像は `issuePhotoUrl()` が組み立てる
	 * `GET /issues/:id/photo` から読む。
	 */
	has_photo: boolean;

	/**
	 * 匿名で起票されたかどうか（#88）。
	 *
	 * 真の場合は「匿名の方」として表示する。偽の場合は起票者が名乗ることを
	 * 選んでおり、表示名が `display_name` に入る。
	 */
	is_anonymous: boolean;

	/**
	 * 起票者の表示名（#67）。
	 *
	 * API が Clerk Backend API から引いた値。生の `user_id` は返らない。
	 *
	 * `null` は「匿名で起票された」「Clerk に表示名が登録されていない」
	 * 「Clerk へ問い合わせられなかった」の 3 通りを表す。最初のものは
	 * `is_anonymous` で見分けられ、残りはまとめて「名前未設定の方」になる
	 * （文言の決定は `packages/shared` の `getAuthorLabel`）。
	 */
	display_name: string | null;

	/**
	 * 「私も困っている」の件数（#112）。
	 *
	 * 一覧のカードに出す。誰が押したかは含まれない（API がそもそも
	 * 返さない。理由は `apps/api/src/routes/reactions.ts`）。
	 * 閲覧者自身が押したかどうかもここには無く、詳細ページが
	 * `lib/reactions.ts` 経由で別に取る。
	 */
	reaction_count: number;
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
		has_photo,
		is_anonymous,
		display_name,
		reaction_count,
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
	// `has_photo`（#65）は、他の項目と違って欠けていても弾かない。
	//
	// Web と API は別 Worker で、デプロイのタイミングがずれる。API が
	// まだ古いときに一覧ごと「取得できませんでした」にすると、写真という
	// 付加的な機能のために画面全体が失われる。写真が出ないだけで済ませたい。
	//
	// 一方、値が入っているのに真偽値でない（型が変わった）場合は弾く。
	// 「無い」と「想定と違う形で来た」は別で、後者を握り潰すと API 側の
	// 変更が画面に静かに影響する。
	if (has_photo !== undefined && typeof has_photo !== "boolean") return null;

	// `is_anonymous`（#88）も欠けていれば弾かないが、倒す先が逆になる。
	//
	// この値を返さない古い API に対して一覧ごと失敗させると、画面から
	// Issue が消えるだけで、誰も匿名性の問題に気づけない。一方で
	// 「名乗っている」に倒すのは、名乗るつもりのなかった投稿を晒すことに
	// なり、取り返しが付かない。だから欠けていれば匿名として読む。
	//
	// ただし `0` / `"false"` のような**別の型の値**は弾く。SQLite の 0/1 が
	// 変換されずに出てきたときに黙って truthy 判定するとちょうど逆の意味
	// （0 = 匿名でない）に読めてしまうため、それは形の不一致として扱う。
	if (is_anonymous !== undefined && typeof is_anonymous !== "boolean") {
		return null;
	}

	// `display_name`（#67）も欠けていれば弾かず、null として読む。
	// 表示名は「あると嬉しい」情報でしかなく、API 側がまだ返さない
	// （デプロイのズレ）ときに一覧ごと失われるのは本末転倒。名前が
	// 出ないだけで済ませる。
	//
	// 一方、文字列でも null でもない値は弾く。「無い」と「想定と違う形で
	// 来た」は別で、後者を握り潰すと画面に想定外の値がそのまま出る。
	if (
		display_name !== undefined &&
		display_name !== null &&
		typeof display_name !== "string"
	) {
		return null;
	}

	// `reaction_count`（#112）も `has_photo` と同じ扱いで、欠けていれば
	// 弾かずに 0 として読む。この値を返さない古い API に対して一覧ごと
	// 失敗させると、件数という付加的な情報のために画面全体が失われる。
	//
	// 値が入っているのに数値でない・有限でない場合は弾く。件数として
	// 描画できない値をそのまま渡すと "NaN 人" のような表示になる。
	// 負の数もここで落とす。件数が負になる経路は無く、来たなら
	// 想定と違うものが返っている。
	if (
		reaction_count !== undefined &&
		(typeof reaction_count !== "number" ||
			!Number.isFinite(reaction_count) ||
			reaction_count < 0)
	) {
		return null;
	}

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
		has_photo: has_photo ?? false,
		is_anonymous: is_anonymous ?? true,
		display_name: display_name ?? null,
		reaction_count: reaction_count ?? 0,
	};
}

/**
 * Issue に添付された写真の URL を組み立てる。
 *
 * R2 のバケットは公開しておらず、画像は API の
 * `GET /issues/:id/photo` からしか読めない（#65）。Worker を必ず通す
 * ことで、通報された画像の非公開化を後から差し込む余地が残る。
 *
 * `has_photo` が false の Issue に対して呼んでも URL は返る（叩けば 404）。
 * 出し分けは呼び出し側の責務で、この関数は URL の組み立てだけを担う。
 */
export function issuePhotoUrl(issueId: string): string {
	return `${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}/photo`;
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

/**
 * この module が使う範囲だけを表した `fetch` の型。
 *
 * `typeof globalThis.fetch` にしてはいけない。テストは `apps/api` の
 * vitest から動く（web にテストランナーが無いため）が、api の
 * `tsconfig.json` は `types: ["@cloudflare/workers-types"]` を指定していて、
 * そこでは `globalThis.fetch` と `RequestInit` が Workers 版に差し替わる。
 * Workers の `RequestInit` に `cache` は無いため、web 単体では通る
 * `{ cache: "no-store" }` が api 側の `tsc --noEmit` でだけ型エラーになる。
 *
 * 実行環境（ブラウザ / Node / Workers）ではなく、この module が
 * 呼び出す形そのものを型にすることで、どちらの型検査でも同じ意味になる。
 */
type FetchLike = (
	url: string,
	init: { cache: "no-store"; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

/**
 * 実行環境の `fetch`。差し替えない場合の既定値。
 *
 * `const defaultFetch = globalThis.fetch` と書いて module のロード時に
 * 束縛してはいけない。`apps/web/test/page.test.tsx` は Server Component を
 * 描画する前に `globalThis.fetch` を差し替えるが、束縛済みだとその差し替えが
 * 届かず、テストが実物の API へ通信しに行ってしまう。
 * 呼ぶ瞬間に読むことで、差し替えが効く。
 *
 * キャストしているのは、上の `FetchLike` の理由と同じく
 * `globalThis.fetch` の型が型検査する側の設定に左右されるため。
 * 実行時に動くのはブラウザまたは Node（Next.js の Server Component）の
 * `fetch` で、どちらも `cache` を受け付けるため挙動は変わらない。
 */
const defaultFetch: FetchLike = (url, init) =>
	(globalThis.fetch as unknown as FetchLike)(url, init);

type FetchIssuesOptions = {
	/** 取得件数。API 側の上限は 100。 */
	limit?: number;
	/** 絞り込み・並べ替え条件。省略時は既定値（絞り込み無し・新しい順・先頭ページ） */
	filters?: IssueFilters;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * API から Issue のコメント一覧を取得する。
 *
 * Server Component から呼ぶ前提（`fetchIssue` と同じ）。取得関数をこのファイルに
 * まとめているのは、`cache: "no-store"` を含む記述が Workers の型と噛み合わず、
 * api 側の `tsc` に巻き込むと型エラーになるため（`lib/api.ts` の同種のコメント参照）。
 * 形の検証や投稿など、api 側からテストしたい純粋なロジックは `lib/comments.ts` にある。
 *
 * 親 Issue が存在しないとき（404）は「取得に失敗した」ではなく空の一覧を返す。
 * 詳細ページは Issue 本体とコメントを並行に取りに行くため、その隙に Issue が
 * 削除されると、コメント側だけが 404 を返すことがある。これを失敗として扱うと
 * 「時間をおいて再度お試しください」という、時間をおいても直らない案内が出る。
 * 404 は「読むべきコメントが無い」であって障害ではないので、空として扱う。
 */
export async function fetchComments(
	issueId: string,
	{ fetchImpl = defaultFetch }: FetchIssueOptions = {},
): Promise<FetchCommentsResult> {
	const url = `${resolveApiBaseUrl()}/issues/${encodeURIComponent(issueId)}/comments`;

	try {
		// 投稿したコメントが次のアクセスで見えるよう、キャッシュしない
		const res = await fetchImpl(url, { cache: "no-store" });

		if (res.status === 404) {
			return { ok: true, comments: [], total: 0 };
		}
		if (!res.ok) {
			return { ok: false, error: `API が ${res.status} を返しました` };
		}

		const parsed = parseListCommentsResponse(await res.json());
		if (!parsed) {
			return { ok: false, error: "API のレスポンス形式が想定と異なります" };
		}

		return { ok: true, comments: parsed.comments, total: parsed.total };
	} catch (err) {
		console.error("GET /issues/:id/comments に失敗", err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/**
 * 一覧エンドポイントを叩いて結果を組み立てる。
 * 公開一覧（`/issues`）と自分の一覧（`/issues/mine`）で共有する。
 *
 * `token` があれば `Authorization: Bearer` を付ける。Web と API は別オリジンで
 * Clerk の Cookie が届かないため、認証が要る経路はこのヘッダが唯一の手段になる。
 */
function buildListQueryParams(
	limit: number,
	filters?: IssueFilters,
): URLSearchParams {
	// 値のエスケープは `URLSearchParams` に任せる。手で連結すると
	// カテゴリやキーワードに含まれる `&` `=` `#` がクエリを壊す
	const params = new URLSearchParams({ limit: String(limit) });
	if (!filters) return params;
	if (filters.scope) params.set("scope", filters.scope);
	if (filters.status) params.set("status", filters.status);
	if (filters.category) params.set("category", filters.category);
	if (filters.q) params.set("q", filters.q);
	if (filters.sort !== DEFAULT_ISSUE_FILTERS.sort) {
		params.set("sort", filters.sort);
	}
	if (filters.offset > 0) params.set("offset", String(filters.offset));
	return params;
}

async function fetchIssueList(
	path: string,
	{
		limit,
		token,
		filters,
		fetchImpl,
	}: {
		limit: number;
		token?: string;
		filters?: IssueFilters;
		fetchImpl: FetchLike;
	},
): Promise<FetchIssuesResult & { unauthorized?: boolean }> {
	const url = `${resolveApiBaseUrl()}${path}?${buildListQueryParams(limit, filters).toString()}`;

	try {
		// 投稿された Issue が次のアクセスで見えるよう、キャッシュしない
		const res = await fetchImpl(url, {
			cache: "no-store",
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		});

		if (!res.ok) {
			return {
				ok: false,
				error: `API が ${res.status} を返しました`,
				// 401 だけは「サインインし直せば直る」ので呼び出し側に区別させる
				unauthorized: res.status === 401,
			};
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
			offset: filters?.offset ?? 0,
		};
	} catch (err) {
		// API が落ちている / 名前解決できない / JSON として壊れている。
		// 生の例外メッセージ（`fetch failed` など）は画面に出さず、
		// 切り分けに要る情報はサーバーのログに残す
		console.error(`GET ${path} に失敗`, err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/**
 * API から Issue 一覧を取得する。
 *
 * Server Component から呼ぶことを前提にしている（サーバー間通信なので
 * ブラウザの CORS を経由しない）。
 */
export async function fetchIssues({
	limit = 20,
	filters = DEFAULT_ISSUE_FILTERS,
	fetchImpl = defaultFetch,
}: FetchIssuesOptions = {}): Promise<FetchIssuesResult> {
	const result = await fetchIssueList("/issues", { limit, filters, fetchImpl });
	// 公開エンドポイントなので `unauthorized` は意味を持たない。
	// 呼び出し側の型に余計な分岐を持ち込まないよう落とす。
	const { unauthorized: _unauthorized, ...rest } = result;
	return rest;
}

/**
 * 自分が起票した Issue の取得結果。
 *
 * 失敗のうち「サインインが必要」だけは、利用者が自分で解消できる。
 * 「時間をおいて再度お試しください」と同じ扱いにすると直しようがないため、
 * `unauthorized` で区別して呼び出し側が案内を変えられるようにする。
 */
export type FetchMyIssuesResult =
	| { ok: true; issues: PublicIssue[]; total: number }
	| { ok: false; error: string; unauthorized: boolean };

type FetchMyIssuesOptions = {
	/**
	 * Clerk のセッショントークン。
	 * 未サインインなら null（`auth().getToken()` がそのまま null を返す）。
	 */
	token: string | null;
	/** 取得件数。API 側の上限は 100。 */
	limit?: number;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * API から「自分が起票した Issue」の一覧を取得する（`GET /issues/mine`）。
 *
 * 絞り込みの条件はトークンに紐づく userId ひとつで、こちらから誰の分かを
 * 指定する余地は無い（API 側も同じ）。
 */
export async function fetchMyIssues({
	token,
	limit = 20,
	fetchImpl = defaultFetch,
}: FetchMyIssuesOptions): Promise<FetchMyIssuesResult> {
	// トークンが無いなら API を呼んでも 401 が返るだけ。
	// 往復せずにその場で未認証として返す。
	if (!token) {
		return {
			ok: false,
			error: "ログインが必要です",
			unauthorized: true,
		};
	}

	const result = await fetchIssueList("/issues/mine", {
		limit,
		token,
		fetchImpl,
	});
	if (result.ok) {
		return result;
	}
	return {
		ok: false,
		error: result.error,
		unauthorized: result.unauthorized ?? false,
	};
}

/**
 * Issue 1 件の取得結果。
 *
 * 一覧（`FetchIssuesResult`）と違い、失敗を `notFound` で二分している。
 * 「その ID の Issue は存在しない」と「取得できなかった」は利用者が取るべき
 * 行動が違う（URL を疑う / 時間をおく）ため、呼び出し側で描き分けられるようにする。
 * 一時的な障害を 404 として扱うと、実在する Issue に対して
 * 「存在しません」と嘘の断定を出してしまう。
 */
export type FetchIssueResult =
	| { ok: true; issue: PublicIssue }
	| { ok: false; notFound: true }
	| { ok: false; notFound: false; error: string };

type FetchIssueOptions = {
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * API から Issue を 1 件取得する。
 *
 * `fetchIssues` と同じく Server Component から呼ぶ前提で、失敗しても
 * throw せず値で返す。
 */
export async function fetchIssue(
	id: string,
	{ fetchImpl = defaultFetch }: FetchIssueOptions = {},
): Promise<FetchIssueResult> {
	// ID はパスセグメントに入るため、必ずエンコードする。
	// `..` やスラッシュを含む値をそのまま連結すると、別のエンドポイントを
	// 叩かせられる（`/issues/../health` が `/health` に潰れる）
	const url = `${resolveApiBaseUrl()}/issues/${encodeURIComponent(id)}`;

	try {
		// 起票直後や更新直後に開いても最新が見えるよう、キャッシュしない
		const res = await fetchImpl(url, { cache: "no-store" });

		if (res.status === 404) {
			return { ok: false, notFound: true };
		}
		if (!res.ok) {
			return {
				ok: false,
				notFound: false,
				error: `API が ${res.status} を返しました`,
			};
		}

		const issue = parsePublicIssue(await res.json());
		if (!issue) {
			return {
				ok: false,
				notFound: false,
				error: "API のレスポンス形式が想定と異なります",
			};
		}

		return { ok: true, issue };
	} catch (err) {
		console.error(`GET /issues/${id} に失敗`, err);
		return {
			ok: false,
			notFound: false,
			error: "API に接続できませんでした",
		};
	}
}
