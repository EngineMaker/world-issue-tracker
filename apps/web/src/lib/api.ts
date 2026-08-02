import {
	type CreateIssue,
	CreateIssueSchema,
} from "@world-issue-tracker/shared";

/**
 * API のベース URL。
 *
 * Web と API は別オリジン（別 Worker）にデプロイされるため、相対パスでは届かない。
 * `NEXT_PUBLIC_` 接頭辞の値はビルド時にクライアントバンドルへ埋め込まれるので、
 * デプロイ環境ごとにビルド時の環境変数として与える必要がある
 * （`.github/workflows/deploy.yml` の web ジョブを参照）。
 *
 * 未設定ならローカル開発の既定値 `http://localhost:8787` を使う。
 * 本番で設定を忘れると localhost へ投げて失敗するが、これは
 * 「本番の API URL を推測して別のどこかへ送る」よりは安全側に倒している。
 */
export const API_BASE_URL =
	process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * フォームの入力値（すべて文字列）。
 *
 * `<input>` から得られる値は数値項目でも文字列なので、
 * スキーマに渡す前の生の形をそのまま型にしている。
 */
export type IssueFormValues = {
	title: string;
	description: string;
	scope: string;
	latitude: string;
	longitude: string;
	category: string;
};

/** フィールド名 → そのフィールドのエラーメッセージ。 */
export type FieldErrors = Partial<Record<keyof IssueFormValues, string[]>>;

/**
 * 起票フォームで提示するカテゴリの入力候補。
 *
 * `CreateIssueSchema` の `category` は自由入力（`z.string().min(1).max(100)`）の
 * ままにしている。enum にすると候補に無い困りごとが起票できなくなるうえ、
 * 既存データの移行も要るため、まずは候補を提示して表記ゆれを減らす。
 * 実際に集まった値を見てから、`packages/shared` へ引き上げて enum 化するかを
 * 別途判断する。
 *
 * 置き場所について。API は自由文字列を受けるだけで候補を知る必要がないため、
 * `packages/shared`（API と Web の双方が使う定義の置き場）ではなく画面側に置いた。
 * ただし候補を `page.tsx` に直書きすると「語彙を一箇所に集める」という目的が
 * 崩れるので、定数として切り出している。
 *
 * このファイル（API との通信を担う）に置いたのは、web にテストランナーが無く、
 * `apps/api/test/node/` から相対 import して検証する必要があるため。
 * `lib/issues.ts` は Workers の型と噛み合わない記述（`fetch` の `cache`）を含み、
 * api 側の `tsc` に巻き込むと型エラーになる。責務としては表示用の語彙なので、
 * web にテストを置ける環境が整ったら移し直す余地がある。
 *
 * 各候補はスキーマの制約（1〜100 文字）に収まること。
 * 順序は日常的に起票されやすいと思われる順。
 */
export const ISSUE_CATEGORY_SUGGESTIONS: readonly string[] = [
	"道路・交通",
	"防犯・安全",
	"衛生・ごみ",
	"公園・緑地",
	"上下水道",
	"福祉・介護",
	"子育て・教育",
	"医療・健康",
	"住まい",
	"災害・防災",
	"環境・気候",
	"行政手続き",
];

export type ValidationResult =
	| { success: true; data: CreateIssue }
	| { success: false; fieldErrors: FieldErrors; formErrors: string[] };

/**
 * 空文字を `undefined` に、それ以外はそのまま返す。
 *
 * 未入力の任意項目（`category`）を空文字のまま渡すと `min(1)` に引っかかる。
 * 「入力していない」は「空の値を入力した」ではないので、スキーマに渡す前に落とす。
 */
function omitEmpty(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * 数値項目の文字列を数値に変換する。
 *
 * `Number("")` は `0` になるため、空文字は `undefined` にして
 * 「未入力」として `CreateIssueSchema` の required エラーに落とす。
 * 変換できない文字列は `NaN` のまま渡し、これもスキーマ側で弾かれる。
 */
function toNumber(value: string): number | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : Number(trimmed);
}

/**
 * フォームの入力値を `CreateIssueSchema` で検証する。
 *
 * 入力項目の定義は `packages/shared` のスキーマ一本に寄せており、
 * ここで項目やその制約（最大長、緯度経度の範囲）を書き直していない。
 * スキーマが変われば、この関数を通る検証も自動的に追随する。
 */
export function validateIssueForm(values: IssueFormValues): ValidationResult {
	const parsed = CreateIssueSchema.safeParse({
		title: values.title.trim(),
		description: values.description.trim(),
		scope: values.scope,
		latitude: toNumber(values.latitude),
		longitude: toNumber(values.longitude),
		category: omitEmpty(values.category),
	});

	if (parsed.success) {
		return { success: true, data: parsed.data };
	}

	const flattened = parsed.error.flatten();
	return {
		success: false,
		fieldErrors: flattened.fieldErrors as FieldErrors,
		formErrors: flattened.formErrors,
	};
}

/** `createIssue` が投稿に失敗したときに投げるエラー。 */
export class CreateIssueError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "CreateIssueError";
		this.status = status;
	}
}

/**
 * API のエラーレスポンスから、利用者に見せるメッセージを組み立てる。
 *
 * `POST /issues` は Zod の `flatten()` した結果を `error` に載せて返す
 * （`apps/api/src/routes/issues.ts`）ため、その形なら中身を取り出す。
 * 形が違う場合や本文が読めない場合はステータスから定型文にフォールバックする。
 */
function messageFromErrorBody(body: unknown, status: number): string {
	const error = (body as { error?: unknown } | null)?.error;

	if (typeof error === "string") {
		return error;
	}

	if (error && typeof error === "object") {
		const { fieldErrors, formErrors } = error as {
			fieldErrors?: Record<string, string[]>;
			formErrors?: string[];
		};
		const messages = [
			...(formErrors ?? []),
			...Object.entries(fieldErrors ?? {}).map(
				([field, errors]) => `${field}: ${errors.join(", ")}`,
			),
		];
		if (messages.length > 0) {
			return messages.join(" / ");
		}
	}

	if (status === 401) {
		return "ログインが必要です。サインインし直してから送信してください。";
	}
	if (status === 403) {
		return "この操作は許可されていません。";
	}
	return `投稿に失敗しました (HTTP ${status})`;
}

/**
 * Issue を起票する。
 *
 * Web と API は別オリジンなので、Clerk のセッション Cookie は API へ送られない。
 * `useAuth().getToken()` で取ったセッショントークンを `Authorization: Bearer` で
 * 明示的に渡す必要がある（API 側もこの経路を想定しており、Bearer があれば
 * Origin 検証を免除する — `apps/api/src/middleware/origin.ts`）。
 */
export async function createIssue(
	input: CreateIssue,
	token: string | null,
): Promise<{ id: string }> {
	if (!token) {
		throw new CreateIssueError(
			"ログインが必要です。サインインしてから送信してください。",
			401,
		);
	}

	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/issues`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(input),
		});
	} catch {
		// fetch が reject するのは通信そのものが成立しなかった場合
		// （オフライン、DNS 解決失敗、CORS で遮断など）。
		throw new CreateIssueError(
			"API に接続できませんでした。ネットワーク接続を確認してください。",
			null,
		);
	}

	if (!response.ok) {
		// エラー本文が JSON とは限らない（Workers が返す 5xx など）ので、
		// 解析に失敗してもステータス由来のメッセージで続行する
		const body = await response.json().catch(() => null);
		throw new CreateIssueError(
			messageFromErrorBody(body, response.status),
			response.status,
		);
	}

	return (await response.json()) as { id: string };
}
