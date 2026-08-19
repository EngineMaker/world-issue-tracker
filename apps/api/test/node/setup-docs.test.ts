import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_WEB_ORIGIN } from "@world-issue-tracker/shared";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** git 管理下のファイル一覧。クローン直後に存在するファイルと一致する。 */
const trackedFiles = new Set(
	execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
		.split("\n")
		.filter(Boolean),
);

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

/** `KEY=value` 形式の行からキー名を取り出す。コメント行と空行は無視する。 */
const parseEnvKeys = (content: string) =>
	content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => line.split("=")[0] ?? "");

describe("README のセットアップ手順", () => {
	it("cp でコピーする元ファイルがすべて git 管理下にある", () => {
		const readme = readRepoFile("README.md");
		const sources = [...readme.matchAll(/^cp\s+(\S+)\s+\S+$/gm)].map(
			(match) => match[1],
		);

		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) {
			expect(
				trackedFiles,
				`README が参照する ${source} が存在しない`,
			).toContain(source);
		}
	});
});

describe("環境変数のサンプルファイル", () => {
	it("apps/api/.dev.vars.example が Bindings の CLERK_* キーを網羅している", () => {
		// Bindings 型のうち DB は wrangler.jsonc のバインディングなので
		// .dev.vars で渡すのは CLERK_* のみ
		const bindings = readRepoFile("apps/api/src/index.ts");
		const secretKeys = [
			...bindings.matchAll(/^\t(CLERK_\w+):\s*string;$/gm),
		].map((match) => match[1]);
		const exampleKeys = parseEnvKeys(
			readRepoFile("apps/api/.dev.vars.example"),
		);

		expect(secretKeys.length).toBeGreaterThan(0);
		for (const key of secretKeys) {
			expect(exampleKeys, `${key} が .dev.vars.example にない`).toContain(key);
		}
	});

	it("apps/web/.env.local.example が Clerk のキーを含む", () => {
		const exampleKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		);

		expect(exampleKeys).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
		expect(exampleKeys).toContain("CLERK_SECRET_KEY");
	});

	it("サンプルファイルが実際の値を含まない", () => {
		const examples = [
			"apps/api/.dev.vars.example",
			"apps/web/.env.local.example",
		];

		for (const path of examples) {
			for (const line of readRepoFile(path).split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "" || trimmed.startsWith("#")) continue;
				const separator = trimmed.indexOf("=");
				const key = trimmed.slice(0, separator);
				const value = trimmed.slice(separator + 1);

				// URL のような公開してよい設定値は実値のままサンプルに書く。
				// 秘匿すべきなのは資格情報なので、検査対象をそちらに限定する。
				// ここを緩めすぎると実キーの混入を見逃すため、
				// 「除外してよいキー」を列挙する側（許可リスト）にしている。
				if (key === "NEXT_PUBLIC_API_URL") {
					expect(value, `${path} の ${key} が URL でない`).toMatch(
						/^https?:\/\//,
					);
					continue;
				}

				// 値が空なら、そもそも漏れる実値が無い。
				// 「既定を持たせず、必要なときだけ設定する」項目がこの形になる
				// （地図タイルの配信元 — 既定値を焼き込むと規約違反の
				// トラフィックを出すため、意図的に空にしている）
				if (value === "") {
					continue;
				}

				// Clerk の実キーはランダム文字列が続く。
				// プレースホルダは `xxxx` で終わることを必須とする
				expect(value, `${path} に実値らしき文字列がある: ${line}`).toMatch(
					/x{4,}$/,
				);
			}
		}
	});

	it("apps/web/.env.local.example が API のベース URL を含む", () => {
		const exampleKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		);

		expect(exampleKeys).toContain("NEXT_PUBLIC_API_URL");
	});

	it("サンプルは git 管理下にあり、実体は .gitignore で無視されている", () => {
		expect(trackedFiles).toContain("apps/api/.dev.vars.example");
		expect(trackedFiles).toContain("apps/web/.env.local.example");
		expect(trackedFiles).not.toContain("apps/api/.dev.vars");
		expect(trackedFiles).not.toContain("apps/web/.env.local");
	});
});

/**
 * `NEXT_PUBLIC_*` は Next.js のビルド時に値が埋め込まれる。デプロイの
 * ワークフローで渡し忘れると、本番の Web がローカルの API を見に行き、
 * 一覧が空のまま何のエラーも出ない。ユニットテストでは検出できない種類の
 * 事故なので、ワークフローの記述そのものを検査する。
 */
describe("デプロイワークフローの環境変数", () => {
	const deployWorkflow = readRepoFile(".github/workflows/deploy.yml");

	it("web のビルドに NEXT_PUBLIC_API_URL を渡している", () => {
		expect(deployWorkflow).toMatch(/^\s+NEXT_PUBLIC_API_URL:\s*\S+$/m);
	});

	it("渡している API URL が本番の API を指している", () => {
		const match = deployWorkflow.match(/^\s+NEXT_PUBLIC_API_URL:\s*(\S+)$/m);
		expect(match?.[1]).toBe(
			"https://world-issue-tracker-api.mktoho.workers.dev",
		);
	});

	it("web が使う NEXT_PUBLIC_* がすべてワークフローで渡されている", () => {
		// サンプルに載っているキーは web が使うキー。
		// 新しい NEXT_PUBLIC_* を足したときの渡し忘れをここで捕まえる
		const publicKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		).filter((key) => key.startsWith("NEXT_PUBLIC_"));

		expect(publicKeys.length).toBeGreaterThan(0);
		for (const key of publicKeys) {
			expect(deployWorkflow, `${key} が deploy.yml で渡されていない`).toContain(
				`${key}:`,
			);
		}
	});
});

/**
 * デプロイ後の動作確認を本番で起票して行うと、その Issue が「最近の Issue」に
 * 並んだまま残る（#69 で実際に起きた）。トップページの実例がテストデータでは
 * サービスの説明が裏切られるが、これはコードのどこも壊れていないため
 * ユニットテストでは検出できない。防げるのは手順を決めておくことだけなので、
 * README にその手順が書かれていること自体を検査する。
 *
 * 検査するのは「読み取りだけで済ませる確認手段が示されていること」と
 * 「やむを得ず本番に書いた場合の消し方が示されていること」の 2 点。
 * 文面の言い回しには踏み込まず、手順として成立するのに欠かせない
 * 具体的なコマンド・エンドポイントの記述の有無だけを見る。
 */
describe("README のデプロイ後確認手順", () => {
	const readme = readRepoFile("README.md");

	/**
	 * 見出しの本文を、次の同レベル以上の見出しの手前まで取り出す。
	 *
	 * 節の範囲を絞らないと、README の他の箇所（ローカル開発の節に出てくる
	 * `--local` の d1 execute など）を拾ってしまい、手順が書かれていなくても
	 * 検査が通る。一方で見出しレベルを固定すると、節を `###` から `##` へ
	 * 上げ下げしただけで内容が変わっていないのに落ちる。見出しの深さは
	 * 実際に見つかったものを使い、それより浅いか同じ深さの見出しで区切る。
	 */
	const sectionBody = (heading: string): string => {
		const start = readme.match(new RegExp(`\\n(#{2,6}) ${heading}[^\\n]*\\n`));
		const hashes = start?.[1];
		if (!start?.index || !hashes) return "";

		const rest = readme.slice(start.index + start[0].length);
		const next = rest.search(new RegExp(`\\n#{2,${hashes.length}} `));
		return next === -1 ? rest : rest.slice(0, next);
	};

	/** 書き込まずに済ませる確認手段を示す節。 */
	const verification = sectionBody("デプロイ後の確認");

	/** 本番に入れてしまったデータの後始末を示す節。 */
	const cleanup = sectionBody("本番に入れてしまったデータを消す");

	it("デプロイ後の確認手順の節がある", () => {
		expect(verification.trim()).not.toBe("");
	});

	it("書き込みを伴わない確認手段として /health と GET /issues を挙げている", () => {
		// この 2 つは公開エンドポイントで、D1 への疎通まで確認できる。
		// 起票せずに済ませられることが分かる形で書かれている必要がある
		expect(verification, "/health への言及がない").toContain("/health");
		expect(verification, "GET /issues への言及がない").toMatch(
			/GET\s+\/issues|\/issues\?/,
		);
	});

	it("Web の到達確認が本番の Web オリジンを指している", () => {
		// 「最近の Issue」を grep して Web の疎通を見るコマンドは、旧 URL
		// （*.workers.dev）のままだと 308 リダイレクトを追わず本文が取れず、
		// 正常な本番を「失敗」と誤判定する（#140）。確認先が本番の Web
		// オリジン（PRODUCTION_WEB_ORIGIN）と一致していることを検査する。
		const webCheckLine = verification
			.split("\n")
			.find((line) => line.includes("curl") && line.includes("最近の Issue"));

		expect(webCheckLine, "Web の到達確認コマンドが見当たらない").toBeTruthy();

		const url = webCheckLine?.match(/https?:\/\/[^\s/"']+/)?.[0];
		expect(url, "確認コマンドに URL が無い").toBeTruthy();
		expect(url).toBe(new URL(PRODUCTION_WEB_ORIGIN).origin);
	});

	it("本番へ起票して確認しないよう促している", () => {
		// 言い回しは問わない。「起票」と否定表現が同じ文に出てくることだけを見る。
		// 語尾を列挙すると、意味の変わらない書き換えで落ちてテストが邪魔になる
		expect(verification).toMatch(
			/起票[^\n]*(しない|せず|は避け|やめ|不要|禁止|ないで)/,
		);
	});

	it("後始末の節がある", () => {
		expect(cleanup.trim()).not.toBe("");
	});

	/**
	 * `wrangler d1 execute` の 1 コマンド分。行継続（`\` 改行）で複数行に
	 * またがるため、次のコマンドか空行までを 1 つとして拾う。
	 */
	const d1Commands = (markdown: string): string[] =>
		[
			...markdown.matchAll(/wrangler\s+d1\s+execute[\s\S]*?(?=\n\n|\n#|$)/g),
		].map((match) => match[0]);

	it("本番の D1 を直接操作する手順になっている", () => {
		// 起票したデータは user_id が本人のものになるため DELETE /issues/:id でも
		// 消せるが、確認用アカウントを使い分けていると所有者が一致せず 403 になる。
		// 経路として確実なのは wrangler の d1 execute なので、そちらを必須にする
		expect(cleanup, "wrangler d1 execute の手順がない").toMatch(
			/wrangler\s+d1\s+execute/,
		);
	});

	it("後始末の d1 execute がすべて --remote を指定している", () => {
		// `--remote` が無いとローカルの D1 が対象になり、手順どおりに実行しても
		// 本番のデータは残る。「消したつもりで残る」のは #69 そのものなので、
		// 節のどこかに --remote があることではなく、コマンドごとに検査する
		const commands = d1Commands(cleanup);

		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			expect(
				command,
				`--remote の無い d1 execute がある:\n${command}`,
			).toContain("--remote");
		}
	});

	it("消す前に対象を特定する SELECT を示している", () => {
		// id を確認せずに DELETE を打たせないための手順。
		// ここが抜けると「条件を当てずっぽうで書いて実データを消す」経路が開く
		expect(cleanup, "対象を特定する SELECT の例がない").toMatch(
			/SELECT[^\n]*FROM\s+issues/i,
		);
	});

	it("削除の SQL が id 指定で 1 件だけを対象にしている", () => {
		// WHERE の無い DELETE や、条件が緩い DELETE を手順として載せると
		// 実データを巻き込んで消しかねない。id 指定であることを必須にする。
		// 節を限定せず README 全体を見る。危険な例がどこに書かれていても困る
		const deleteStatements = [
			...readme.matchAll(/DELETE\s+FROM\s+issues([^\n;]*)/gi),
		].map((match) => match[1]);

		expect(deleteStatements.length).toBeGreaterThan(0);
		for (const rest of deleteStatements) {
			expect(
				rest,
				`WHERE の無い DELETE がある: DELETE FROM issues${rest}`,
			).toMatch(/\bWHERE\b[^\n]*\bid\s*=/i);
		}
	});

	it("消したあとに消えたことを確認する手順がある", () => {
		// 消して終わりにすると、消えたつもりで残る。実際 #69 は
		// 「確認用に入れたものが残っている」という形で表面化した
		expect(cleanup, "削除後の確認手順がない").toMatch(/curl|SELECT/i);
	});
});
