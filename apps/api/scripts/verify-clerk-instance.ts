/**
 * デプロイした API が本番用の Clerk インスタンスで動いているか確かめる（#98）。
 *
 * web には本番ビルドの手前に関門がある（`apps/web/scripts/check-clerk-keys.ts`）。
 * だが API のキーは Workers Secrets にあり、値は書き込み専用で読み出せない。
 * ビルド前に検査する材料がそもそも無いので、同じ形の関門は作れない。
 *
 * そこで順序を入れ替える。デプロイしてから、出したばかりの API 自身に
 * 種別を聞く（`GET /health/auth`）。開発用インスタンスなら非ゼロで終了し、
 * デプロイのワークフローが赤くなる。
 *
 * 「出てしまってから気付く」形になるのは、Secrets の値を事前に読めない以上
 * 避けられない。それでも #98 の再発検出としては成立する。#98 は本番に出た
 * 開発用キーが**何ヶ月も誰にも気付かれなかった**という不備で、実際に見つけたのは
 * 別件（#93）の確認中に人がブラウザのコンソールを見たときだった。
 * デプロイのたびに必ず赤くなるなら、気付くまでの時間は 1 デプロイ分に縮む。
 *
 * 併せて deploy.yml で `deploy-web` を `deploy-api` の後に置いている。
 * ここで落ちれば web は出ないので、「API だけ本番用・web だけ開発用」で
 * 本番が動く時間帯（#98 の補足が名指しで警告している状態）を作らずに済む。
 */

import { clerkKeyKind } from "@world-issue-tracker/shared";

/** 本番 API の URL。deploy.yml から渡す（web の NEXT_PUBLIC_API_URL と同じ値）。 */
const API_URL_ENV = "API_URL";

/** 検証するキーと、レスポンス上の名前の対応。 */
const CHECKED_KEYS = [
	{ field: "secretKey", name: "CLERK_SECRET_KEY" },
	{ field: "publishableKey", name: "CLERK_PUBLISHABLE_KEY" },
] as const;

type AuthHealth = {
	clerk?: Record<string, unknown>;
};

/**
 * `GET /health/auth` の応答から問題を並べる。
 *
 * 応答が想定の形でない場合も問題として扱う。デプロイした版が古くて
 * このエンドポイントを持っていない、URL が別のサービスを指している、
 * といった場合に「問題なし」を返すと、検証したつもりで何も見ていない
 * ことになる。取得に失敗したことと問題が無かったことは違う。
 */
export function findClerkInstanceProblems(body: unknown): string[] {
	const clerk = (body as AuthHealth | null)?.clerk;
	if (!clerk || typeof clerk !== "object") {
		return [
			"応答に clerk の情報が含まれていません（デプロイした版が /health/auth を持っていない可能性）",
		];
	}

	const problems: string[] = [];

	for (const { field, name } of CHECKED_KEYS) {
		const kind = clerk[field];

		if (kind === "production") {
			continue;
		}

		if (kind === "development") {
			problems.push(`${name} が開発用インスタンスのキーです`);
			continue;
		}

		if (kind === "unset") {
			problems.push(
				`${name} が設定されていないか、Clerk のキーの形式ではありません`,
			);
			continue;
		}

		// production/development/unset のどれでもない。API 側の実装が
		// 変わったか、別のサービスを見ている。判定できない以上、
		// 本番用と断定して素通りさせない。
		problems.push(
			`${name} の種別を判定できませんでした（応答: ${JSON.stringify(kind)}）`,
		);
	}

	return problems;
}

/**
 * 応答の種別が API 側の判定と食い違っていないかを確かめるための対応表。
 *
 * `clerkKeyKind` は `"production" | "development" | null` を返し、API は
 * `null` を `"unset"` に置き換えて返す。この関数が返す値の集合が、上の
 * `findClerkInstanceProblems` が解釈できる集合と一致していること自体を
 * テストで固定する（片方だけ変えると検証が黙って無効になるため）。
 */
export function expectedKindValues(): string[] {
	const kinds = [
		clerkKeyKind("pk_live_x"),
		clerkKeyKind("pk_test_x"),
		clerkKeyKind(undefined),
	];
	return kinds.map((kind) => kind ?? "unset");
}

async function main(): Promise<void> {
	const apiUrl = process.env[API_URL_ENV];
	if (!apiUrl) {
		console.error(
			`${API_URL_ENV} が設定されていません。検証する API の URL を渡してください。`,
		);
		process.exit(1);
	}

	const endpoint = new URL("/health/auth", apiUrl);

	let body: unknown;
	try {
		const res = await fetch(endpoint, {
			headers: { accept: "application/json" },
		});
		if (!res.ok) {
			// 取得できなかったことを「問題なし」に倒さない。
			console.error(
				`${endpoint} が ${res.status} を返しました。Clerk インスタンスの種別を確認できていません。`,
			);
			process.exit(1);
		}
		body = await res.json();
	} catch (err) {
		console.error(
			`${endpoint} への問い合わせに失敗しました。Clerk インスタンスの種別を確認できていません。`,
			err,
		);
		process.exit(1);
	}

	const problems = findClerkInstanceProblems(body);
	if (problems.length === 0) {
		console.log("Clerk は本番インスタンスで動いています（#98）。");
		return;
	}

	console.error(
		[
			"デプロイした API が本番用の Clerk インスタンスで動いていません（#98）。",
			"",
			...problems.map((problem) => `  - ${problem}`),
			"",
			"開発用インスタンスには Clerk 側の利用者数上限があり、上限に達すると",
			"サインインできなくなります。またサインイン画面に「Development mode」が表示されます。",
			"",
			"apps/api で次を実行し、本番用のキーを設定し直してください:",
			"  bun wrangler secret put CLERK_SECRET_KEY",
			"  bun wrangler secret put CLERK_PUBLISHABLE_KEY",
			"",
			"web 側（GitHub のリポジトリ Secrets）も同時に本番用へ切り替えること。",
			"片方だけだとトークンを発行した先と検証する先が食い違い、認証が通らなくなります。",
		].join("\n"),
	);
	process.exit(1);
}

// テストから import したときに実行されないよう、直接起動されたときだけ動かす。
if (import.meta.main) {
	await main();
}
